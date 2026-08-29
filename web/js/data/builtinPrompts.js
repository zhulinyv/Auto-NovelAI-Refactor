// ============================================================
// 内置提示词库 (参考 sd-webui-prompt-all-in-one 预设):
//   分类分组展示, 同组标签横向排列, 可多选后一次性加入提示词。
//   每个标签为 [英文 tag, 中文翻译]。
// ============================================================
export const builtinPromptGroups = [
  {
    name: "✨ 画质",
    tags: [
      ["best quality", "最佳质量"], ["masterpiece", "杰作"], ["high quality", "高质量"],
      ["very aesthetic", "高美感"], ["absurdres", "超高分辨率"], ["ultra-detailed", "超精细细节"],
      ["intricate details", "复杂细节"], ["newest", "最新画风"], ["8k", "8K 画质"],
    ],
  },
  {
    name: "🎬 镜头",
    tags: [
      ["close-up", "特写"], ["portrait", "肖像"], ["upper body", "上半身"],
      ["cowboy shot", "七分身"], ["full body", "全身"], ["wide shot", "远景"],
      ["from above", "俯视"], ["from below", "仰视"], ["from side", "侧面"],
      ["from behind", "背后"], ["dutch angle", "倾斜镜头"], ["dynamic angle", "动态视角"],
    ],
  },
  {
    name: "💡 光影",
    tags: [
      ["cinematic lighting", "电影级光效"], ["soft lighting", "柔和光照"], ["dramatic shadow", "戏剧性阴影"],
      ["golden hour", "黄昏暖光"], ["rim lighting", "轮廓光"], ["backlighting", "逆光"],
      ["dappled sunlight", "斑驳阳光"], ["sunlight", "阳光"], ["neon lights", "霓虹灯"],
      ["bioluminescence", "生物荧光"], ["candlelight", "烛光"], ["moonlight", "月光"],
    ],
  },
  {
    name: "🌸 氛围",
    tags: [
      ["cherry blossoms", "樱花"], ["falling petals", "飘落花瓣"], ["starry night", "星空"],
      ["aurora", "极光"], ["sunset", "日落"], ["night sky", "夜空"],
      ["underwater", "水下"], ["rain", "下雨"], ["snowing", "下雪"],
      ["fireworks", "烟花"], ["city lights", "城市灯火"], ["mist", "薄雾"],
    ],
  },
  {
    name: "🎨 画风",
    tags: [
      ["watercolor (medium)", "水彩"], ["impressionism", "印象派"], ["sketch", "素描"],
      ["lineart", "线稿"], ["flat color", "平涂上色"], ["semi-realistic", "半写实"],
      ["monochrome", "单色"], ["greyscale", "灰度"], ["pastel colors", "柔和色彩"],
      ["vivid colors", "鲜艳色彩"], ["muted colors", "低饱和色彩"], ["oil painting (medium)", "油画"],
    ],
  },
  {
    name: "👗 服装",
    tags: [
      ["school uniform", "校服"], ["maid outfit", "女仆装"], ["kimono", "和服"],
      ["lolita fashion", "洛丽塔"], ["gothic fashion", "哥特装"], ["hoodie", "连帽衫"],
      ["pleated skirt", "百褶裙"], ["thighhighs", "过膝袜"], ["hair ribbon", "发带"],
      ["hair ornament", "发饰"], ["coat", "外套"], ["dress", "连衣裙"],
    ],
  },
  {
    name: "😄 表情动作",
    tags: [
      ["smile", "微笑"], ["open mouth", "张嘴"], ["blush", "脸红"],
      ["crying", "哭泣"], ["surprised", "惊讶"], ["wink", "眨眼"],
      ["laughing", "大笑"], ["pouting", "撅嘴"], ["looking at viewer", "看向镜头"],
      ["peace sign", "剪刀手"], ["hands on hips", "叉腰"], ["standing", "站立"],
    ],
  },
];
