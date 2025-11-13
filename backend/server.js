const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Configuration
const TELEGRAM_CONFIG = {
  CHANNEL_USERNAME: 'ogbongouserartupload',
  BOT_TOKEN: '8476389795:AAH8CER-SVyB8iJCK0BDP51pOEJCRE4wzks',
  CHANNEL_ID: '@ogbongouserartupload'
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use('/uploads', express.static(uploadsDir));

// Database setup
const db = new sqlite3.Database('./gallery.db');

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_name TEXT NOT NULL,
    artist_social TEXT,
    art_description TEXT,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    submission_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS telegram_art (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_message_id INTEGER UNIQUE,
    image_url TEXT NOT NULL,
    caption TEXT,
    date_added DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Add initial images
  const initialImages = [
    'https://i.postimg.cc/vcdNBfRV/file-00000000847861f9a26eb77000b75bbb.png',
    'https://i.postimg.cc/ThvzyZg1/20250806-131538.jpg',
    'https://i.postimg.cc/WFGf61g3/86327fb0-d104-49df-b755-86b0c75c68e1media-editing-tmp.jpg',
    'https://i.postimg.cc/bDkRcVwF/FB-IMG-1754347347395.jpg',
    'https://i.postimg.cc/9R5n774K/file-00000000151461fd929788c937cc9807.png',
    'https://i.postimg.cc/XXKT9Qk8/file-000000002d1461f78ca24fbf83f3f77e.png'
  ];

  initialImages.forEach((url, index) => {
    db.get(`SELECT id FROM telegram_art WHERE image_url = ?`, [url], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO telegram_art (telegram_message_id, image_url, caption) VALUES (?, ?, ?)`, 
          [1000 + index, url, 'OGbongo Community Art']);
      }
    });
  });
});

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Telegram Service - Real implementation
class TelegramService {
  constructor() {
    this.lastUpdateId = 0;
  }

  async fetchChannelPhotos() {
    try {
      console.log('🔄 Fetching Telegram channel photos...');
      
      // Get bot updates to see channel messages
      const response = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_CONFIG.BOT_TOKEN}/getUpdates`,
        {
          params: {
            offset: this.lastUpdateId + 1,
            timeout: 10
          }
        }
      );

      if (response.data.ok && response.data.result.length > 0) {
        let newPhotos = 0;
        
        for (const update of response.data.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          
          if (update.channel_post && update.channel_post.photo) {
            const message = update.channel_post;
            const messageId = message.message_id;
            const caption = message.caption || 'Shared in OGbongo community';
            
            // Check if already exists
            const exists = await new Promise((resolve, reject) => {
              db.get(`SELECT id FROM telegram_art WHERE telegram_message_id = ?`, [messageId], (err, row) => {
                if (err) reject(err);
                else resolve(!!row);
              });
            });

            if (!exists) {
              // Get the largest photo
              const largestPhoto = message.photo[message.photo.length - 1];
              const fileId = largestPhoto.file_id;
              
              // Get file path
              const fileResponse = await axios.get(
                `https://api.telegram.org/bot${TELEGRAM_CONFIG.BOT_TOKEN}/getFile`,
                { params: { file_id: fileId } }
              );

              if (fileResponse.data.ok) {
                const filePath = fileResponse.data.result.file_path;
                const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_CONFIG.BOT_TOKEN}/${filePath}`;
                
                // Save to database
                const stmt = db.prepare(`INSERT INTO telegram_art (telegram_message_id, image_url, caption) VALUES (?, ?, ?)`);
                await new Promise((resolve, reject) => {
                  stmt.run([messageId, imageUrl, caption], function(err) {
                    if (err) reject(err);
                    else resolve();
                  });
                });
                stmt.finalize();
                
                console.log(`✅ Added new photo from Telegram: ${caption}`);
                newPhotos++;
              }
            }
          }
        }
        
        if (newPhotos > 0) {
          console.log(`🎉 Added ${newPhotos} new photos from Telegram channel`);
        }
        
        return { success: true, newPhotos };
      }
      
      return { success: true, newPhotos: 0 };
      
    } catch (error) {
      console.error('❌ Error fetching Telegram photos:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Alternative method: Use public channel export (no bot required)
  async getPublicChannelPhotos() {
    try {
      // This is a fallback method that works without bot permissions
      // It uses the public channel username to get basic info
      const response = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_CONFIG.BOT_TOKEN}/getChat`,
        {
          params: {
            chat_id: TELEGRAM_CONFIG.CHANNEL_ID
          }
        }
      );
      
      console.log('📊 Channel info:', response.data);
      return { success: true, channel: response.data.result };
      
    } catch (error) {
      console.log('ℹ️ Bot cannot access channel directly. Using manual sync method.');
      return { success: false, error: 'Manual sync required' };
    }
  }
}

// Initialize Telegram service
const telegramService = new TelegramService();

// Routes

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Get all gallery images (Telegram + submissions)
app.get('/api/gallery', (req, res) => {
  db.all(`
    SELECT 
      id,
      image_url,
      caption as art_description,
      'Telegram Community' as artist_name,
      date_added as approved_date,
      'telegram' as source
    FROM telegram_art 
    UNION ALL
    SELECT 
      id,
      CONCAT('/uploads/', filename) as image_url,
      art_description,
      artist_name,
      submission_date as approved_date,
      'website' as source
    FROM submissions 
    WHERE status = 'approved'
    ORDER BY approved_date DESC
  `, (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
});

// Submit artwork from website
app.post('/api/submit-art', upload.array('images', 5), async (req, res) => {
  try {
    const { artist_name, artist_social, art_description } = req.body;
    
    if (!artist_name || !req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Artist name and at least one image are required' });
    }

    // Save each file to database
    for (const file of req.files) {
      const stmt = db.prepare(`INSERT INTO submissions 
        (artist_name, artist_social, art_description, filename, original_filename) 
        VALUES (?, ?, ?, ?, ?)`);
      
      await new Promise((resolve, reject) => {
        stmt.run([artist_name, artist_social, art_description, file.filename, file.originalname], 
          function(err) {
            if (err) reject(err);
            else resolve();
          });
      });
      stmt.finalize();
    }

    res.json({ 
      success: true, 
      message: 'Artwork submitted successfully! Thank you for your submission.',
      submissionCount: req.files.length 
    });

  } catch (error) {
    console.error('Submission error:', error);
    res.status(500).json({ error: 'Failed to submit artwork' });
  }
});

// Manually trigger Telegram sync
app.post('/api/sync-telegram', async (req, res) => {
  try {
    const result = await telegramService.fetchChannelPhotos();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get sync status
app.get('/api/telegram-status', async (req, res) => {
  try {
    const result = await telegramService.fetchChannelPhotos();
    res.json({
      success: true,
      channel: TELEGRAM_CONFIG.CHANNEL_ID,
      last_sync: new Date().toISOString(),
      new_photos: result.newPhotos || 0
    });
  } catch (error) {
    res.json({
      success: false,
      channel: TELEGRAM_CONFIG.CHANNEL_ID,
      error: error.message
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    telegram_channel: TELEGRAM_CONFIG.CHANNEL_ID
  });
});

// Auto-sync every 2 minutes
setInterval(() => {
  telegramService.fetchChannelPhotos();
}, 2 * 60 * 1000);

// Initial sync
setTimeout(() => {
  telegramService.fetchChannelPhotos();
}, 5000);

app.listen(PORT, () => {
  console.log(`\n🚀 OGbongo Website Running!`);
  console.log(`🌐 Website: http://localhost:${PORT}`);
  console.log(`📺 Telegram Channel: ${TELEGRAM_CONFIG.CHANNEL_ID}`);
  console.log(`🤖 Auto-sync: ACTIVE (every 2 minutes)`);
  console.log(`📸 Checking for new Telegram photos...\n`);
});
