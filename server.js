import express from 'express';
import bodyParser from 'body-parser';
import ytld from 'yt-dlp-exec';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(bodyParser.json());

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// Serve static downloads folder
app.use('/downloads', express.static(DOWNLOAD_DIR));

// Convert Shorts URL to regular watch URL
function convertShorts(url) {
  const match = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
  if (match) return `https://www.youtube.com/watch?v=${match[1]}`;
  return url;
}

// POST /download
app.post('/download', async (req, res) => {
  try {
    let { url, type } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    url = convertShorts(url); // handle Shorts
    const id = uuidv4();
    const filename = type === 'audio' ? `${id}.mp3` : `${id}.mp4`;
    const filepath = path.join(DOWNLOAD_DIR, filename);

    const args = [
      url,
      '--force-ipv4',
      '--geo-bypass',
      '--no-playlist',
      '--hls-prefer-native',
      '--concurrent-fragments', '5',
      '--no-progress',
      '-o', filepath
    ];

    if (type === 'audio') {
      args.push('-x', '--audio-format', 'mp3');
    }

    await ytld(args, { stdio: 'ignore' });

    res.json({
      download_url: `${req.protocol}://${req.get('host')}/downloads/${filename}`,
      message: `Downloaded successfully!`,
      type,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to download', details: err.message });
  }
});

// Optional: cleanup old files every hour
setInterval(() => {
  const files = fs.readdirSync(DOWNLOAD_DIR);
  files.forEach(file => {
    const filePath = path.join(DOWNLOAD_DIR, file);
    const stats = fs.statSync(filePath);
    const now = Date.now();
    if (now - stats.mtimeMs > 2 * 60 * 60 * 1000) { // older than 2 hours
      fs.unlinkSync(filePath);
    }
  });
}, 3600 * 1000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
