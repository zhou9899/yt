import express from "express";
import cors from "cors";
import { exec } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";

const execPromise = util.promisify(exec);
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const TEMP_DIR = path.join(process.cwd(), "temp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/* ---------- HELPERS ---------- */

// Convert shorts → watch URL
function normalizeUrl(url) {
  if (!url) return null;
  const m = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
  return url;
}

// Base yt-dlp args (SINGLE LINE — IMPORTANT)
function baseArgs() {
  return [
    "--force-ipv4",
    "--user-agent \"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15\"",
    "--extractor-args \"youtube:player_client=web_safari\"",
    "--geo-bypass",
    "--no-playlist",
    "--hls-prefer-native",
    "--concurrent-fragments 8",
    "--no-progress"
  ].join(" ");
}

/* ---------- ROUTES ---------- */

app.get("/ping", (_, res) => res.send("pong"));

// Shorts test
app.post("/test-shorts", (req, res) => {
  const { url } = req.body;
  res.json({ convertedUrl: normalizeUrl(url) });
});

// Search only
app.post("/test-search", async (req, res) => {
  const { search } = req.body;
  if (!search) return res.status(400).json({ error: "Missing search" });

  try {
    const { stdout } = await execPromise(
      `yt-dlp "ytsearch5:${search}" --print "%(title)s"`
    );
    res.json({ result: stdout.trim().split("\n") });
  } catch {
    res.status(500).json({ error: "Search failed" });
  }
});

// Download endpoint
app.post("/download", async (req, res) => {
  const { url, search, type = "video" } = req.body;

  const input = search
    ? `ytsearch1:${search}`
    : normalizeUrl(url);

  if (!input) {
    return res.status(400).json({ error: "No URL or search provided" });
  }

  const id = `yt-${Date.now()}`;
  const output = path.join(TEMP_DIR, `${id}.%(ext)s`);

  let format;
  let post = "";

  if (type === "audio") {
    format = `"bv*[protocol=m3u8]/ba*[protocol=m3u8]/best"`;
    post = "-x --audio-format mp3";
  } else {
    format = `"bv*[protocol=m3u8]/best"`;
  }

  const cmd = `yt-dlp ${baseArgs()} -f ${format} ${post} -o "${output}" "${input}"`;

  try {
    await execPromise(cmd);

    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
    if (!files.length) throw new Error("No output file");

    res.json({
      downloadUrl: `/file/${files[0]}`,
      type
    });

  } catch (e) {
    res.status(500).json({
      error: "Failed to download",
      details: e.stderr || e.message,
      hint: "Local IPs are throttled. Railway/VPS works best."
    });
  }
});

// Serve downloaded file
app.get("/file/:name", (req, res) => {
  const filePath = path.join(TEMP_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  res.download(filePath);
});

/* ---------- START ---------- */

app.listen(PORT, () => {
  console.log(`🚀 YouTube API running on port ${PORT}`);
});
