const express = require('express');
const cors = require('cors');
const multer = require('multer');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3000,
  WEBSITE_URL: process.env.WEBSITE_URL || `http://localhost:${PORT}`,
  // Telegram Configuration
  TELEGRAM_CHANNEL: '@ogbongouserartupload', // Your Telegram channel
  TELEGRAM_BOT_TOKEN: '', // Optional: Add bot token for auto-sync
  // Email configuration (optional)
  EMAIL_ENABLED: false,
  EMAIL_USER: 'bongodevem@gmail.com',
  EMAIL_PASS: ''
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create necessary directories
const uploadsDir = path.join(__dirname, 'uploads', 'submissions');
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

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

  db.run(`CREATE TABLE IF NOT EXISTS approved_art (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER,
    telegram_message_id TEXT UNIQUE,
    image_url TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    artist_social TEXT,
    art_description TEXT,
    approved_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (submission_id) REFERENCES submissions (id)
  )`);

  // Add some sample approved art
  const sampleArt = [
    {
      telegram_message_id: 'sample1',
      image_url: 'https://i.postimg.cc/vcdNBfRV/file-00000000847861f9a26eb77000b75bbb.png',
      artist_name: 'OGbongo Team',
      art_description: 'Original Bongo Character'
    },
    {
      telegram_message_id: 'sample2',
      image_url: 'https://i.postimg.cc/ThvzyZg1/20250806-131538.jpg',
      artist_name: 'OGbongo Team',
      art_description: 'Bongo Evolution'
    }
  ];

  sampleArt.forEach(art => {
    db.get(`SELECT id FROM approved_art WHERE telegram_message_id = ?`, [art.telegram_message_id], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO approved_art (telegram_message_id, image_url, artist_name, art_description) 
                VALUES (?, ?, ?, ?)`, 
                [art.telegram_message_id, art.image_url, art.artist_name, art.art_description]);
      }
    });
  });
});

// Multer configuration for file uploads
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
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Telegram Utility Functions
class TelegramSync {
  // Method to manually sync from Telegram channel (for testing)
  static async syncFromTelegram() {
    try {
      console.log('🔄 Attempting to sync from Telegram channel...');
      
      // Since we don't have a bot token, we'll use a manual approach
      // In a real implementation, you would use the Telegram Bot API
      
      // For now, we'll return a message about manual sync
      return {
        success: true,
        message: 'Telegram auto-sync requires bot token. Use manual sync via admin panel.',
        synced_count: 0
      };
      
    } catch (error) {
      console.error('Telegram sync error:', error);
      return {
        success: false,
        error: 'Telegram sync failed: ' + error.message
      };
    }
  }

  // Extract image URL from Telegram message (helper function)
  static extractImageUrl(telegramMessage) {
    // This is a simplified version - in reality, you'd parse Telegram API response
    if (telegramMessage.photo && telegramMessage.photo.length > 0) {
      const fileId = telegramMessage.photo[telegramMessage.photo.length - 1].file_id;
      return `https://api.telegram.org/file/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${fileId}`;
    }
    return null;
  }

  // Manual sync endpoint for admin
  static async manualSync(imageUrl, telegramMessageId, artistName = 'Community Artist', description = '') {
    try {
      // Check if this message already exists
      const existing = await new Promise((resolve, reject) => {
        db.get(`SELECT id FROM approved_art WHERE telegram_message_id = ?`, [telegramMessageId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (existing) {
        return { success: false, error: 'This Telegram message is already synced' };
      }

      // Add to approved art
      const stmt = db.prepare(`INSERT INTO approved_art 
        (telegram_message_id, image_url, artist_name, art_description) 
        VALUES (?, ?, ?, ?)`);
      
      const result = await new Promise((resolve, reject) => {
        stmt.run([telegramMessageId, imageUrl, artistName, description], function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        });
      });

      stmt.finalize();

      return {
        success: true,
        message: 'Artwork synced from Telegram successfully!',
        id: result.id
      };

    } catch (error) {
      console.error('Manual sync error:', error);
      return {
        success: false,
        error: 'Manual sync failed: ' + error.message
      };
    }
  }
}

// Routes

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Submit artwork
app.post('/api/submit-art', upload.array('images', 5), async (req, res) => {
  try {
    const { artist_name, artist_social, art_description } = req.body;
    
    if (!artist_name || !req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Artist name and at least one image are required' });
    }

    const submissionData = [];
    
    // Save each file to database
    for (const file of req.files) {
      const stmt = db.prepare(`INSERT INTO submissions 
        (artist_name, artist_social, art_description, filename, original_filename) 
        VALUES (?, ?, ?, ?, ?)`);
      
      await new Promise((resolve, reject) => {
        stmt.run([artist_name, artist_social, art_description, file.filename, file.originalname], 
          function(err) {
            if (err) reject(err);
            else {
              submissionData.push({
                id: this.lastID,
                filename: file.filename,
                originalname: file.originalname
              });
              resolve();
            }
          });
      });
      stmt.finalize();
    }

    res.json({ 
      success: true, 
      message: 'Artwork submitted successfully! It will be reviewed soon.',
      submissionCount: req.files.length 
    });

  } catch (error) {
    console.error('Submission error:', error);
    res.status(500).json({ error: 'Failed to submit artwork' });
  }
});

// Get pending submissions (for admin)
app.get('/api/admin/submissions', (req, res) => {
  db.all(`SELECT * FROM submissions WHERE status = 'pending' ORDER BY submission_date DESC`, 
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      const submissions = rows.map(row => ({
        ...row,
        image_url: `${CONFIG.WEBSITE_URL}/uploads/${row.filename}`
      }));
      
      res.json(submissions);
    });
});

// Approve submission
app.post('/api/admin/approve/:id', (req, res) => {
  const { id } = req.params;
  const { telegram_message_id, image_url } = req.body;

  db.get(`SELECT * FROM submissions WHERE id = ?`, [id], (err, submission) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Move to approved table
    const stmt = db.prepare(`INSERT INTO approved_art 
      (submission_id, telegram_message_id, image_url, artist_name, artist_social, art_description) 
      VALUES (?, ?, ?, ?, ?, ?)`);
    
    stmt.run([id, telegram_message_id, image_url, submission.artist_name, 
              submission.artist_social, submission.art_description], 
      function(err) {
        if (err) {
          return res.status(500).json({ error: 'Failed to approve submission' });
        }

        // Update submission status
        db.run(`UPDATE submissions SET status = 'approved' WHERE id = ?`, [id]);

        res.json({ 
          success: true, 
          message: 'Submission approved successfully',
          approved_id: this.lastID 
        });
      });
    
    stmt.finalize();
  });
});

// Reject submission
app.post('/api/admin/reject/:id', (req, res) => {
  const { id } = req.params;

  db.run(`UPDATE submissions SET status = 'rejected' WHERE id = ?`, [id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to reject submission' });
    }
    
    res.json({ success: true, message: 'Submission rejected' });
  });
});

// Get approved artwork for gallery
app.get('/api/gallery', (req, res) => {
  db.all(`SELECT * FROM approved_art ORDER BY approved_date DESC`, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
});

// Manual add from Telegram
app.post('/api/admin/add-from-telegram', async (req, res) => {
  const { telegram_message_id, image_url, artist_name, artist_social, art_description } = req.body;

  if (!telegram_message_id || !image_url || !artist_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const result = await TelegramSync.manualSync(
    image_url, 
    telegram_message_id, 
    artist_name, 
    art_description
  );

  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

// New: Quick add from Telegram (simplified)
app.post('/api/admin/quick-telegram-add', async (req, res) => {
  const { telegram_url } = req.body;

  if (!telegram_url) {
    return res.status(400).json({ error: 'Telegram message URL is required' });
  }

  try {
    // Extract message ID from Telegram URL
    const messageId = telegram_url.split('/').pop();
    
    const result = await TelegramSync.manualSync(
      telegram_url, // Using the URL directly as image source
      messageId,
      'Telegram Community',
      'Art from Telegram channel'
    );

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to add Telegram content: ' + error.message });
  }
});

// New: Auto-sync from Telegram (manual trigger)
app.post('/api/admin/telegram-sync', async (req, res) => {
  const result = await TelegramSync.syncFromTelegram();
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

// New: Get Telegram sync status
app.get('/api/admin/telegram-status', (req, res) => {
  const status = {
    channel: CONFIG.TELEGRAM_CHANNEL,
    bot_configured: !!CONFIG.TELEGRAM_BOT_TOKEN,
    auto_sync_available: !!CONFIG.TELEGRAM_BOT_TOKEN,
    manual_sync_available: true
  };
  
  res.json(status);
});

// Admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    config: {
      telegram_channel: CONFIG.TELEGRAM_CHANNEL,
      website_url: CONFIG.WEBSITE_URL
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
    }
  }
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Auto-sync on startup (if bot token is configured)
if (CONFIG.TELEGRAM_BOT_TOKEN) {
  console.log('🤖 Telegram bot token detected, auto-sync enabled');
  // Start periodic sync every 5 minutes
  setInterval(() => {
    TelegramSync.syncFromTelegram();
  }, 5 * 60 * 1000);
} else {
  console.log('ℹ️  No Telegram bot token configured. Using manual sync mode.');
}

app.listen(PORT, () => {
  console.log(`🚀 OGbongo Backend running on port ${PORT}`);
  console.log(`🌐 Website: http://localhost:${PORT}`);
  console.log(`🔧 Admin Panel: http://localhost:${PORT}/admin`);
  console.log(`📺 Telegram Channel: ${CONFIG.TELEGRAM_CHANNEL}`);
  console.log(`🤖 Auto-sync: ${CONFIG.TELEGRAM_BOT_TOKEN ? 'ENABLED' : 'MANUAL MODE'}`);
});
