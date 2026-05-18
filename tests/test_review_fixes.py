import io
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

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
