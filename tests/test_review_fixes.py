import io
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from utils.errors import NovelAIAPIError
from utils.generator import Generator, _safe_output_path


def _zip_with_image(name="image_0.png", content=b"image"):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as zip_file:
        zip_file.writestr(name, content)
    return data.getvalue()


class DummyResponse:
    def __init__(self, status_code=200, content=b"", text="", body=None):
        self.status_code = status_code
        self.content = content
        self.text = text
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


def test_generator_raises_on_http_error(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "outputs").mkdir()

    def fake_post(**kwargs):
        return DummyResponse(status_code=401, body={"message": "bad token"})

    monkeypatch.setattr("utils.generator.requests.post", fake_post)

    with pytest.raises(NovelAIAPIError, match="401"):
        Generator("https://example.invalid").generate({"parameters": {}})


def test_generator_raises_on_successful_non_zip(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "outputs").mkdir()

    def fake_post(**kwargs):
        return DummyResponse(status_code=200, content=b"not a zip")

    monkeypatch.setattr("utils.generator.requests.post", fake_post)
    monkeypatch.setattr("utils.generator.inquire_anlas", lambda: 123)

    with pytest.raises(NovelAIAPIError, match="non-zip"):
        Generator("https://example.invalid").generate({"parameters": {}})


def test_safe_output_path_rejects_path_escape(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "outputs").mkdir()
    monkeypatch.setattr("utils.generator.env", SimpleNamespace(custom_path="../escape/<编号>"))

    with pytest.raises(ValueError, match="inside ./outputs"):
        _safe_output_path("text2image", 1)


def test_safe_output_path_supports_chinese_placeholders(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "outputs").mkdir()
    monkeypatch.setattr("utils.generator.env", SimpleNamespace(custom_path="<类型>/<日期>/<种子>_<编号>"))

    path = _safe_output_path("text2image", 123)

    assert path.parents[2] == Path("outputs").resolve()
    assert path.name == "123_00000.png"


def test_furry_vibe_uses_furry_model():
    from utils.models import naif3vibe

    payload = naif3vibe(
        _input="prompt",
        width=64,
        height=64,
        scale=5,
        sampler="k_euler",
        steps=1,
        ucPreset=0,
        qualityToggle=False,
        sm=False,
        sm_dyn=False,
        dynamic_thresholding=False,
        legacy=False,
        add_original_image=True,
        cfg_rescale=0,
        noise_schedule="karras",
        legacy_v3_extend=False,
        skip_cfg_above_sigma=None,
        seed=1,
        negative_prompt="",
        deliberate_euler_ancestral_bug=False,
        prefer_brownian=True,
        use_new_shared_trial=True,
        reference_image_multiple=["img"],
        reference_information_extracted_multiple=[1],
        reference_strength_multiple=[0.5],
    )

    assert payload["model"] == "nai-diffusion-furry-3"
    assert payload["parameters"]["reference_image_multiple"] == ["img"]


def test_generator_reads_bg_removal_images(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "outputs").mkdir()
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as zip_file:
        zip_file.writestr("image_0.png", b"masked")
        zip_file.writestr("image_1.png", b"generated")
        zip_file.writestr("image_2.png", b"blend")

    def fake_post(**kwargs):
        return DummyResponse(status_code=200, content=data.getvalue())

    monkeypatch.setattr("utils.generator.requests.post", fake_post)
    monkeypatch.setattr("utils.generator.inquire_anlas", lambda: 123)

    assert Generator("https://example.invalid").generate({"req_type": "bg-removal"}) == (
        b"masked",
        b"generated",
        b"blend",
    )


def test_share_mode_rejects_paths_outside_outputs(monkeypatch, tmp_path):
    from utils.path_safety import is_share_path_allowed

    monkeypatch.chdir(tmp_path)
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    monkeypatch.setattr("utils.path_safety.env", SimpleNamespace(share=True))

    assert is_share_path_allowed(outputs / "image.png")
    assert not is_share_path_allowed(outside / "image.png")


class FakeImageGenerator:
    def __init__(self, image_data=b"image"):
        self.image_data = image_data
        self.requests = []

    def generate(self, json_data):
        self.requests.append(json_data)
        return self.image_data

    def save(self, image_data, image_type, seed):
        path = Path("outputs") / f"{image_type}_{seed}.png"
        path.write_bytes(image_data)
        return str(path)


def _generation_args(inpaint_input_image=None, inpaint_input_image_mode="图生图", enhance_enable=False):
    character_components = []
    for _ in range(6):
        character_components.extend(["", "", "Center", False, None])
    precise_reference_components = [None] * 60
    vibe_components = [None]

    return (
        "nai-diffusion-3",
        "prompt",
        "",
        "",
        False,
        "None",
        1,
        64,
        64,
        1,
        5,
        0,
        False,
        "1",
        "k_euler",
        "karras",
        False,
        False,
        False,
        False,
        inpaint_input_image,
        inpaint_input_image_mode,
        0.5,
        0.5,
        0,
        None,
        False,
        True,
        enhance_enable,
        "1x",
        1.0,
        *character_components,
        *precise_reference_components,
        *vibe_components,
    )


def _prepare_generation_test(monkeypatch, tmp_path, fake_generator):
    import src.generate_images as generate_images

    monkeypatch.chdir(tmp_path)
    (tmp_path / "outputs").mkdir()
    monkeypatch.setattr(generate_images, "image_generator", fake_generator)
    monkeypatch.setattr(generate_images, "playsound", lambda path: None)
    monkeypatch.setattr(generate_images, "sleep_for_cool", lambda seconds: None)
    monkeypatch.setattr(generate_images, "send_mail", lambda: None)
    monkeypatch.setattr(generate_images.env, "smtp_num", 0)
    return generate_images


def test_generate_images_allows_missing_editor_value_for_text2image(monkeypatch, tmp_path):
    fake_generator = FakeImageGenerator()
    generate_images = _prepare_generation_test(monkeypatch, tmp_path, fake_generator)

    images, message = generate_images.main(*_generation_args(inpaint_input_image=None))

    assert len(images) == 1
    assert "处理完成" in message
    assert fake_generator.requests[0]["action"] == "generate"


def test_generate_images_allows_image2image_without_editor_layers(monkeypatch, tmp_path):
    fake_generator = FakeImageGenerator()
    generate_images = _prepare_generation_test(monkeypatch, tmp_path, fake_generator)
    background = Image.new("RGB", (64, 64), (1, 2, 3))
    editor_value = {"background": background, "layers": [], "composite": background.copy()}

    images, message = generate_images.main(*_generation_args(inpaint_input_image=editor_value))

    assert len(images) == 1
    assert "处理完成" in message
    request = fake_generator.requests[0]
    assert request["action"] == "img2img"
    assert "mask" not in request["parameters"]


def test_generate_images_reports_empty_generation_as_failure(monkeypatch, tmp_path):
    fake_generator = FakeImageGenerator(image_data=None)
    generate_images = _prepare_generation_test(monkeypatch, tmp_path, fake_generator)

    images, message = generate_images.main(*_generation_args(inpaint_input_image=None))

    assert images == []
    assert message == "Generation failed: NovelAI returned empty image data"


def test_send_pnginfo_to_generate_accepts_single_file_json_list(tmp_path):
    from utils.components import send_pnginfo_to_generate

    metadata = {"Comment": {"prompt": "from json", "uc": "negative", "width": 64, "height": 128}}
    metadata_path = tmp_path / "metadata.json"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    values = send_pnginfo_to_generate([str(metadata_path)])

    assert values[0] == "from json"
    assert values[1] == "negative"
    assert values[2] == 64
    assert values[3] == 128


def test_send_pnginfo_to_generate_reads_png_path(tmp_path):
    from utils.components import send_pnginfo_to_generate

    comment = {"prompt": "from png", "uc": "negative", "width": 128, "height": 64}
    metadata = PngInfo()
    metadata.add_text("Comment", json.dumps(comment))
    image_path = tmp_path / "image.png"
    Image.new("RGB", (64, 64), (1, 2, 3)).save(image_path, pnginfo=metadata)

    values = send_pnginfo_to_generate(str(image_path))

    assert values[0] == "from png"
    assert values[1] == "negative"
    assert values[2] == 128
    assert values[3] == 64


def test_send_mail_skips_missing_credentials(monkeypatch):
    import utils

    monkeypatch.setattr(utils.env, "smtp_num", 1)
    monkeypatch.setattr(utils.env, "smtp_mail", None)
    monkeypatch.setattr(utils.env, "smtp_token", None)

    utils.send_mail()
