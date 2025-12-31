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

// Search YouTube and return formatted results
async function searchYoutube(query, limit = 10) {
  try {
    // Search and get video details
    const { stdout } = await execPromise(
      `yt-dlp "ytsearch${limit}:${sanitizeShellInput(query)}" --print "%(title)s ||| %(id)s ||| %(duration)s ||| %(view_count)s ||| %(uploader)s ||| %(thumbnail)s" --no-playlist --quiet --no-warnings`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    
    const lines = stdout.trim().split('\n').filter(line => line.includes('|||'));
    
    const results = lines.map(line => {
      const [title, id, duration, views, uploader, thumbnail] = line.split('|||').map(s => s.trim());
      
      return {
        id,
        title,
        url: `https://www.youtube.com/watch?v=${id}`,
        duration: formatDuration(duration),
        views: formatNumber(views),
        uploader,
        thumbnail: thumbnail || `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
        shortUrl: `https://youtu.be/${id}`,
        shortsUrl: `https://youtube.com/shorts/${id}`
      };
    });
    
    return results;
    
  } catch (error) {
    console.error('Search error:', error);
    throw new Error('Search failed: ' + error.message);
  }
}

// Get detailed video info by URL/ID
async function getVideoInfo(url) {
  try {
    const { stdout } = await execPromise(
      `yt-dlp "${sanitizeShellInput(url)}" --print "%(title)s ||| %(id)s ||| %(duration)s ||| %(view_count)s ||| %(uploader)s ||| %(thumbnail)s ||| %(description)s ||| %(webpage_url)s" --no-playlist --quiet --no-warnings`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    
    const [title, id, duration, views, uploader, thumbnail, description, webpage_url] = 
      stdout.trim().split('|||').map(s => s.trim());
    
    // Get available formats
    const { stdout: formatsStdout } = await execPromise(
      `yt-dlp "${sanitizeShellInput(url)}" --list-formats --quiet`,
      { maxBuffer: 5 * 1024 * 1024 }
    );
    
    const videoFormats = [];
    const audioFormats = [];
    
    const formatLines = formatsStdout.split('\n').filter(line => 
      line.includes('mp4') || line.includes('webm') || line.includes('m4a')
    );
    
    formatLines.forEach(line => {
      if (line.includes('audio only')) {
        const match = line.match(/(\d+)\s+(\w+).*?(\d+\.?\d*\s*\w+)/);
        if (match) {
          audioFormats.push({
            formatId: match[1],
            ext: match[2],
            size: match[3]
          });
        }
      } else if (!line.includes('video only')) {
        const match = line.match(/(\d+)\s+(\w+).*?(\d+x\d+).*?(\d+\.?\d*\s*\w+)/);
        if (match) {
          videoFormats.push({
            formatId: match[1],
            ext: match[2],
            resolution: match[3],
            size: match[4]
          });
        }
      }
    });
    
    return {
      id,
      title,
      url: webpage_url,
      duration: formatDuration(duration),
      views: formatNumber(views),
      uploader,
      thumbnail: thumbnail || `https://img.youtube.com/vi/${id}/maxresdefault.jpg`,
      description: description.substring(0, 200) + (description.length > 200 ? '...' : ''),
      formats: {
        video: videoFormats.slice(0, 5), // Top 5 video formats
        audio: audioFormats.slice(0, 3)  // Top 3 audio formats
      },
      shortUrl: `https://youtu.be/${id}`,
      shortsUrl: `https://youtube.com/shorts/${id}`,
      embedUrl: `https://www.youtube.com/embed/${id}`
    };
    
  } catch (error) {
    console.error('Video info error:', error);
    throw new Error('Failed to get video info');
  }
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const secs = parseInt(seconds);
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const remainingSeconds = secs % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function formatNumber(num) {
  if (!num) return '0';
  const n = parseInt(num);
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1) + 'M';
  } else if (n >= 1000) {
    return (n / 1000).toFixed(1) + 'K';
  }
  return n.toString();
}

// Clean old files
function cleanupOldFiles() {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours
    
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

/* ---------- ROUTES ---------- */

// Home
app.get("/", (req, res) => {
  res.json({
    service: "YouTube Downloader & Search API",
    status: "running",
    endpoints: [
      "/search?q=query",
      "/info?url=video_url",
      "/download",
      "/stream/:id",
      "/health"
    ],
    usage: {
      search: "GET /search?q=never+gonna+give+you+up&limit=5",
      info: "GET /info?url=https://youtube.com/watch?v=dQw4w9WgXcQ",
      download: "POST /download {url, type, quality}"
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

// Search YouTube
app.get("/search", async (req, res) => {
  const { q, limit = 10 } = req.query;
  
  if (!q || q.trim() === '') {
    return res.status(400).json({ error: "Search query is required" });
  }
  
  try {
    const results = await searchYoutube(q, parseInt(limit));
    
    res.json({
      success: true,
      query: q,
      count: results.length,
      results
    });
    
  } catch (error) {
    console.error("Search API error:", error);
    res.status(500).json({ 
      error: "Search failed", 
      message: error.message 
    });
  }
});

// Get video info
app.get("/info", async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }
  
  try {
    const normalizedUrl = normalizeUrl(url) || url;
    const info = await getVideoInfo(normalizedUrl);
    
    res.json({
      success: true,
      ...info
    });
    
  } catch (error) {
    console.error("Video info error:", error);
    res.status(500).json({ 
      error: "Failed to get video info",
      message: error.message 
    });
  }
});

// Download video/audio
app.post("/download", async (req, res) => {
  const { url, type = "video", quality = "medium", formatId } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }
  
  const normalizedUrl = normalizeUrl(url) || url;
  const downloadId = uuidv4().slice(0, 8);
  const ext = type === "audio" ? "mp3" : "mp4";
  const filename = `${downloadId}-${Date.now()}.${ext}`;
  const filepath = path.join(TEMP_DIR, filename);
  
  try {
    // Build yt-dlp arguments
    const args = [
      normalizedUrl,
      "--no-playlist",
      "--geo-bypass",
      "--no-warnings",
      "--quiet",
      "--force-ipv4",
      "--concurrent-fragments", "5",
      "-o", filepath
    ];
    
    if (formatId) {
      // Use specific format ID if provided
      args.push("-f", formatId);
    } else if (type === "audio") {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "192");
    } else {
      // Choose format based on quality
      switch(quality) {
        case "low": args.push("-f", "best[height<=360]"); break;
        case "medium": args.push("-f", "best[height<=720]"); break;
        case "high": args.push("-f", "best[height<=1080]"); break;
        case "best": args.push("-f", "best"); break;
        default: args.push("-f", "best[height<=720]");
      }
    }
    
    console.log(`Downloading: ${normalizedUrl} as ${type}`);
    await executeYtDlp(args);
    
    // Check if file was created
    if (!fs.existsSync(filepath)) {
      throw new Error("File not created");
    }
    
    const stats = fs.statSync(filepath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    // WhatsApp size limits
    const whatsappVideoLimit = 64 * 1024 * 1024; // 64MB
    const whatsappAudioLimit = 16 * 1024 * 1024; // 16MB
    const isTooLarge = type === "video" 
      ? stats.size > whatsappVideoLimit
      : stats.size > whatsappAudioLimit;
    
    res.json({
      success: true,
      downloadId,
      filename,
      originalUrl: url,
      type,
      quality,
      fileSize: stats.size,
      fileSizeMB,
      duration: stats.size / 1024 > 1024 ? `${fileSizeMB} MB` : `${(stats.size / 1024).toFixed(2)} KB`,
      isTooLarge,
      maxAllowedMB: type === "video" ? 64 : 16,
      downloadUrl: `${req.protocol}://${req.get('host')}/stream/${filename}`,
      directUrl: `${req.protocol}://${req.get('host')}/file/${filename}`,
      expiresIn: "2 hours",
      message: isTooLarge 
        ? `File is ${fileSizeMB}MB (WhatsApp limit: ${type === "video" ? 64 : 16}MB). Consider lower quality.`
        : "Download ready"
    });
    
  } catch (error) {
    console.error("Download error:", error);
    
    // Clean up failed download
    try {
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (e) {}
    
    res.status(500).json({
      error: "Download failed",
      message: error.message,
      hint: "Try again with different quality or check the URL"
    });
  }
});

// Stream file
app.get("/stream/:filename", (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(TEMP_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "File not found" });
  }
  
  const ext = path.extname(filename).toLowerCase();
  const contentType = ext === ".mp3" ? "audio/mpeg" : "video/mp4";
  
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  
  const fileStream = fs.createReadStream(filepath);
  fileStream.pipe(res);
  
  fileStream.on("error", (err) => {
    console.error("Stream error:", err);
    res.status(500).send("Error streaming file");
  });
});

// Direct file access
app.get("/file/:filename", (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(TEMP_DIR, filename);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "File not found" });
  }
  
  res.download(filepath, filename, (err) => {
    if (err) {
      console.error("Download error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to download file" });
      }
    }
  });
});

// Cleanup endpoint
app.get("/cleanup", (req, res) => {
  cleanupOldFiles();
  const files = fs.readdirSync(TEMP_DIR);
  res.json({ 
    success: true, 
    filesRemaining: files.length,
    files: files.slice(0, 10) // Show first 10 files
  });
});

/* ---------- START ---------- */

// Initial cleanup
cleanupOldFiles();

// Schedule cleanup every hour
setInterval(cleanupOldFiles, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 YouTube API running on port ${PORT}`);
  console.log(`📁 Temp: ${TEMP_DIR}`);
  console.log(`🔗 Base URL: http://localhost:${PORT}`);
  console.log(`🔍 Search: http://localhost:${PORT}/search?q=your+query`);
});
