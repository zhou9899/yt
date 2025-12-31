import express from "express";
import cors from "cors";
import { exec } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execPromise = util.promisify(exec);
const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 5000;
const TEMP_DIR = path.join(__dirname, "temp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// FIX: Serve static files from /downloads
app.use("/downloads", express.static(TEMP_DIR));

/* ---------- HELPERS ---------- */

function normalizeUrl(url) {
  if (!url) return null;

  // YouTube Shorts
  const shortsMatch = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;

  // youtu.be links
  const shortUrlMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortUrlMatch) return `https://www.youtube.com/watch?v=${shortUrlMatch[1]}`;

  // Regular YouTube
  const videoMatch = url.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (videoMatch) return url;

  return null;
}

function sanitizeShellInput(input) {
  return input.replace(/[`$\\|;&><]/g, '');
}

async function executeYtDlp(args) {
  const safeArgs = args.map(arg => `"${sanitizeShellInput(arg)}"`);
  const command = `yt-dlp ${safeArgs.join(" ")}`;

  try {
    const { stdout, stderr } = await execPromise(command, { maxBuffer: 10 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (error) {
    throw new Error(`yt-dlp failed: ${error.message}`);
  }
}

/* ---------- ROUTES ---------- */

// Home
app.get("/", (req, res) => {
  res.json({
    service: "YouTube Downloader API",
    status: "running",
    endpoints: {
      download: "POST /download",
      file: "GET /downloads/:filename"
    }
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    tempDir: fs.existsSync(TEMP_DIR),
    tempFiles: fs.readdirSync(TEMP_DIR).length
  });
});

// Download video/audio - SIMPLIFIED VERSION
app.post("/download", async (req, res) => {
  const { url, type = "video" } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    const normalizedUrl = normalizeUrl(url) || url;
    const filename = `${uuidv4()}.${type === "audio" ? "mp3" : "mp4"}`;
    const filepath = path.join(TEMP_DIR, filename);

    console.log(`Downloading: ${normalizedUrl}`);

    // Build yt-dlp arguments
    let cmd;
    if (type === "audio") {
      cmd = `yt-dlp -x --audio-format mp3 --audio-quality 192k -o "${filepath}" "${normalizedUrl}"`;
    } else {
      cmd = `yt-dlp -f "best[height<=720]" -o "${filepath}" "${normalizedUrl}"`;
    }

    await execPromise(cmd, { timeout: 180000 }); // 3 minute timeout

    // Check if file was created
    if (!fs.existsSync(filepath)) {
      throw new Error("File not created");
    }

    const stats = fs.statSync(filepath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    // FIXED: Use consistent domain
    const baseUrl = `${req.protocol}://${req.headers.host}`;
    const downloadUrl = `${baseUrl}/downloads/${filename}`;

    res.json({
      success: true,
      filename,
      fileSizeMB,
      type,
      download_url: downloadUrl, // Use lowercase with underscore
      message: `Downloaded ${fileSizeMB}MB`
    });

  } catch (error) {
    console.error("Download error:", error.message);
    res.status(500).json({
      error: "Download failed",
      message: error.message
    });
  }
});

// File info endpoint
app.get("/file/:filename", (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(TEMP_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const stats = fs.statSync(filepath);
  res.json({
    filename,
    size: stats.size,
    sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
    created: stats.mtime
  });
});

/* ---------- CLEANUP ---------- */

function cleanupOldFiles() {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;

    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes (INCREASED from 2 hours)

    let cleaned = 0;
    files.forEach(file => {
      try {
        const filepath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filepath);
        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(filepath);
          cleaned++;
        }
      } catch (e) {
        // Ignore
      }
    });

    if (cleaned > 0) {
      console.log(`Cleaned ${cleaned} old files`);
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Start server
cleanupOldFiles();
setInterval(cleanupOldFiles, 10 * 60 * 1000); // Clean every 10 minutes

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Files at: /downloads/`);
});
