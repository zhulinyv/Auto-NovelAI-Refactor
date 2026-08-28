// ============================================================
// API 客户端: 封装所有后端请求
// ============================================================

export async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      detail = data.detail || detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

export const get = (url) => request("GET", url);
export const post = (url, body) => request("POST", url, body ?? {});
export const del = (url) => request("DELETE", url);

/** 上传文件, 返回 [{name, path}] */
export async function uploadFiles(files) {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  const data = await res.json();
  return data.files;
}

/** 上传目录文件到独立子目录, 返回 {path, count} */
export async function uploadDir(files) {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const res = await fetch("/api/upload-dir", { method: "POST", body: form });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

/** 弹出系统原生文件选择框, 返回真实绝对路径 (后端直接读取, 不上传)。 */
export async function pickFile() {
  const res = await fetch("/api/pick-file", { method: "POST" });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  const data = await res.json();
  return data.path || "";
}

/** 弹出系统原生目录选择框, 返回真实绝对路径。 */
export async function pickFolder() {
  const res = await fetch("/api/pick-folder", { method: "POST" });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  const data = await res.json();
  return data.path || "";
}

/** 图片访问 URL (bust=true 时加时间戳, 用于覆盖后强制刷新) */
export function imageUrl(path, bust = false) {
  return `/api/image?path=${encodeURIComponent(path)}` + (bust ? "&t=" + Date.now() : "");
}

/** 获取应用状态 */
export async function fetchState() {
  return get("/api/state");
}

/** 读取 last.json (每次实时读取, 获取上次生成参数) */
export async function fetchLast() {
  return get("/api/last");
}

/** 在系统文件管理器中打开目录 (默认 outputs 根目录) */
export async function openDir(path) {
  return post("/api/open-dir", path ? { path } : {});
}
