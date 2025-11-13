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
  CHANNEL: '@ogbongouserartupload',
  // You'll need to create a Telegram bot and get these credentials
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '', // Add your bot token here
  CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID || '', // Your channel ID
  SYNC_INTERVAL: 2 * 60 * 1000 // Check every 2 minutes
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
  db.run(`CREATE TABLE IF NOT EXISTS approved_art (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_message_id TEXT UNIQUE,
    image_url TEXT NOT NULL,
    artist_name TEXT DEFAULT 'Community Artist',
    art_description TEXT DEFAULT 'Shared in Telegram channel',
    approved_date DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Add some sample art
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

// Telegram Auto-Sync Service
class TelegramAutoSync {
  constructor() {
    this.lastSyncId = 0;
    this.isSyncing = false;
  }

  async startAutoSync() {
    if (!TELEGRAM_CONFIG.BOT_TOKEN) {
      console.log('🤖 Telegram bot token not configured. Auto-sync disabled.');
      console.log('📝 To enable auto-sync, set TELEGRAM_BOT_TOKEN environment variable');
      return;
    }

    console.log('🔄 Starting Telegram auto-sync service...');
    
    // Initial sync
    await this.syncTelegramChannel();
    
    // Periodic sync
    setInterval(() => {
      this.syncTelegramChannel();
    }, TELEGRAM_CONFIG.SYNC_INTERVAL);

    console.log(`✅ Telegram auto-sync active! Checking every ${TELEGRAM_CONFIG.SYNC_INTERVAL/60000} minutes`);
  }

  async syncTelegramChannel() {
    if (this.isSyncing) return;
    
    this.isSyncing = true;
    try {
      console.log('🔄 Syncing Telegram channel...');
      
      // Get updates from Telegram channel
      const updates = await this.getTelegramUpdates();
      
      if (updates && updates.result && updates.result.length > 0) {
        let newImagesCount = 0;
        
        for (const update of updates.result) {
          if (update.channel_post && update.channel_post.media_group_id) {
            // Handle media groups (multiple images)
            const images = await this.processMediaGroup(update.channel_post.media_group_id);
            newImagesCount += images.length;
          } else if (update.channel_post && update.channel_post.photo) {
            // Handle single image
            const imageAdded = await this.processTelegramImage(update.channel_post);
            if (imageAdded) newImagesCount++;
          }
        }
        
        if (newImagesCount > 0) {
          console.log(`✅ Synced ${newImagesCount} new images from Telegram`);
        }
      }
      
    } catch (error) {
      console.error('❌ Telegram sync error:', error.message);
    } finally {
      this.isSyncing = false;
    }
  }

  async getTelegramUpdates() {
    try {
      const response = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_CONFIG.BOT_TOKEN}/getUpdates`,
        {
          params: {
            offset: this.lastSyncId + 1,
            timeout: 30
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('Telegram API error:', error.message);
      return null;
    }
  }

  async processTelegramImage(telegramPost) {
    try {
      const messageId = telegramPost.message_id;
      const caption = telegramPost.caption || 'Shared in Telegram channel';
      
      // Check if already exists
      const exists = await new Promise((resolve, reject) => {
        db.get(`SELECT id FROM approved_art WHERE telegram_message_id = ?`, [messageId], (err, row) => {
          if (err) reject(err);
          else resolve(!!row);
        });
      });

      if (exists) {
        return false; // Already exists
      }

      // Get the largest available photo
      const largestPhoto = telegramPost.photo[telegramPost.photo.length - 1];
      const fileId = largestPhoto.file_id;

      // Get file path
      const fileResponse = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_CONFIG.BOT_TOKEN}/getFile`,
        { params: { file_id: fileId } }
      );

      const filePath = fileResponse.data.result.file_path;
      const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_CONFIG.BOT_TOKEN}/${filePath}`;

      // Save to database
      const stmt = db.prepare(`INSERT INTO approved_art 
        (telegram_message_id, image_url, artist_name, art_description) 
        VALUES (?, ?, ?, ?)`);
      
      await new Promise((resolve, reject) => {
        stmt.run([messageId, imageUrl, 'Telegram Community', caption], function(err) {
          if (err) reject(err);
          else resolve();
        });
      });

      stmt.finalize();
      
      console.log(`✅ Auto-added Telegram image: ${caption}`);
      this.lastSyncId = Math.max(this.lastSyncId, messageId);
      
      return true;

    } catch (error) {
      console.error('Error processing Telegram image:', error.message);
      return false;
    }
  }

  async processMediaGroup(mediaGroupId) {
    // For multiple images in one post
    // Implementation for media groups would go here
    return [];
  }
}

// Simulated Telegram Sync (for testing without bot token)
class SimulatedTelegramSync {
  constructor() {
    this.simulatedImages = [
      {
        message_id: 'telegram_001',
        image_url: 'https://i.postimg.cc/vcdNBfRV/file-00000000847861f9a26eb77000b75bbb.png',
        caption: 'Bongo Art from Telegram'
      },
      {
        message_id: 'telegram_002', 
        image_url: 'https://i.postimg.cc/ThvzyZg1/20250806-131538.jpg',
        caption: 'Community Bongo Creation'
      }
    ];
    this.currentIndex = 0;
  }

  async startAutoSync() {
    console.log('🔧 Starting SIMULATED Telegram auto-sync (no bot token configured)');
    console.log('💡 To enable real auto-sync, add your Telegram bot token');
    
    // Simulate periodic new images
    setInterval(() => {
      this.simulateNewTelegramImage();
    }, 3 * 60 * 1000); // Every 3 minutes
  }

  async simulateNewTelegramImage() {
    if (this.currentIndex < this.simulatedImages.length) {
      const image = this.simulatedImages[this.currentIndex];
      
      // Check if already exists
      const exists = await new Promise((resolve, reject) => {
        db.get(`SELECT id FROM approved_art WHERE telegram_message_id = ?`, [image.message_id], (err, row) => {
          if (err) reject(err);
          else resolve(!!row);
        });
      });

      if (!exists) {
        const stmt = db.prepare(`INSERT INTO approved_art 
          (telegram_message_id, image_url, artist_name, art_description) 
          VALUES (?, ?, ?, ?)`);
        
        await new Promise((resolve, reject) => {
          stmt.run([image.message_id, image.image_url, 'Telegram Community', image.caption], function(err) {
            if (err) reject(err);
            else resolve();
          });
        });

        stmt.finalize();
        
        console.log(`🤖 SIMULATED: Auto-added image from Telegram: ${image.caption}`);
      }
      
      this.currentIndex++;
    }
  }
}

// Routes

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Get approved artwork for gallery (now includes Telegram images)
app.get('/api/gallery', (req, res) => {
  db.all(`SELECT * FROM approved_art ORDER BY approved_date DESC`, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
});

// Manual sync trigger (for testing)
app.post('/api/telegram-sync', async (req, res) => {
  try {
    if (TELEGRAM_CONFIG.BOT_TOKEN) {
      await telegramSync.syncTelegramChannel();
      res.json({ success: true, message: 'Telegram sync completed' });
    } else {
      await simulatedSync.simulateNewTelegramImage();
      res.json({ success: true, message: 'Simulated sync completed' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Sync failed: ' + error.message });
  }
});

// Get sync status
app.get('/api/telegram-status', (req, res) => {
  const status = {
    auto_sync: !!TELEGRAM_CONFIG.BOT_TOKEN,
    channel: TELEGRAM_CONFIG.CHANNEL,
    last_sync: new Date().toISOString()
  };
  res.json(status);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    telegram: {
      auto_sync: !!TELEGRAM_CONFIG.BOT_TOKEN,
      channel: TELEGRAM_CONFIG.CHANNEL
    }
  });
});

// Initialize Telegram sync
const telegramSync = new TelegramAutoSync();
const simulatedSync = new SimulatedTelegramSync();

// Start the appropriate sync service
if (TELEGRAM_CONFIG.BOT_TOKEN) {
  telegramSync.startAutoSync();
} else {
  simulatedSync.startAutoSync();
}

app.listen(PORT, () => {
  console.log(`🚀 OGbongo Website running on port ${PORT}`);
  console.log(`🌐 Website: http://localhost:${PORT}`);
  console.log(`📺 Telegram Channel: ${TELEGRAM_CONFIG.CHANNEL}`);
  console.log(`🤖 Auto-sync: ${TELEGRAM_CONFIG.BOT_TOKEN ? 'ENABLED 🟢' : 'SIMULATED MODE 🟡'}`);
  
  if (!TELEGRAM_CONFIG.BOT_TOKEN) {
    console.log('\n💡 TO ENABLE REAL TELEGRAM AUTO-SYNC:');
    console.log('1. Create a bot with @BotFather on Telegram');
    console.log('2. Get your bot token');
    console.log('3. Add your bot to your channel as admin');
    console.log('4. Set TELEGRAM_BOT_TOKEN environment variable');
    console.log('5. Restart the server\n');
  }
});
