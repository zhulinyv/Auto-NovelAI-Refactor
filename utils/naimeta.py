import gzip

import numpy as np
import ujson as json
from PIL import Image


class LSBExtractor:
    def __init__(self, data):
        self.data = data
        self.rows, self.cols, self.dim = data.shape
        self.bits = 0
        self.byte = 0
        self.row = 0
        self.col = 0

    def _extract_next_bit(self) -> bool:
        """取下一个 LSB; 像素已用完时返回 False (不再推进游标)。

        注意这里必须返回状态: 早先的实现是"越界就什么都不做", 于是 get_one_byte 的
        while self.bits < 8 永远等不到 8 位 —— 小图 (比如 1x1, 可用位数不足一个字节)
        会让整个读取原地死循环, 而不是抛错走 image_tools 里那层 except 兜底。
        """
        if self.row >= self.rows or self.col >= self.cols:
            return False
        bit = self.data[self.row, self.col, self.dim - 1] & 1
        self.bits += 1
        self.byte <<= 1
        self.byte |= bit
        self.row += 1
        if self.row == self.rows:
            self.row = 0
            self.col += 1
        return True

    def get_one_byte(self):
        """读一个字节; 像素耗尽而且凑不满 8 位时返回 None (调用方据此终止)。"""
        while self.bits < 8:
            if not self._extract_next_bit():
                # 读空: 丢掉半截的位, 让后续调用也得到一致的"读空"
                self.bits = 0
                self.byte = 0
                return None
        byte = bytearray([self.byte])
        self.bits = 0
        self.byte = 0
        return byte

    def get_next_n_bytes(self, n):
        bytes_list = bytearray()
        for _ in range(n):
            byte = self.get_one_byte()
            if not byte:
                break
            bytes_list.extend(byte)
        return bytes_list

    def read_32bit_integer(self):
        bytes_list = self.get_next_n_bytes(4)
        if len(bytes_list) == 4:
            integer_value = int.from_bytes(bytes_list, byteorder="big")
            return integer_value
        else:
            return None


def extract_data_from_array(img):
    """从**已解码**的 RGBA numpy 数组读取 NovelAI 隐写数据 (见 extract_data)。

    供已经持有 RGBA 像素的调用方复用, 避免为一句话的判断把整图再 np.array 一遍
    (图片工具插件的隐写探测就属于这种情况)。
    """
    assert len(img.shape) == 3 and img.shape[-1] == 4, "image format"
    reader = LSBExtractor(img)
    magic = "stealth_pngcomp"
    # 图太小 / 没有隐写数据时读到的是空字节串: decode 会得到长度不足的串, 照样被下面断言拦下
    # (以前会在这里死循环, 见 LSBExtractor._extract_next_bit)
    read_magic = reader.get_next_n_bytes(len(magic)).decode("utf-8")
    assert magic == read_magic, "magic number"
    read_len = reader.read_32bit_integer() // 8
    json_data = reader.get_next_n_bytes(read_len)
    json_data = json.loads(gzip.decompress(json_data).decode("utf-8"))
    return json_data


def extract_data(img: Image.Image):
    # 自动补成 RGBA: 兼容无透明通道的格式 (如 RGB/灰度 webp),
    # 否则 np.array(img).shape[-1] == 3 会触发 "image format" 断言 (法术解析读 webp 报错)。
    return extract_data_from_array(np.array(img.convert("RGBA")))
