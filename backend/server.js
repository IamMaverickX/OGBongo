const express = require('express');
const cors = require('cors');
const multer = require('multer');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { Telegraf } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration with YOUR credentials
const CONFIG = {
  // Telegram Configuration
  TELEGRAM_BOT_TOKEN: '8476389795:AAH8CER-SVyB8iJCK0BDP51pOEJCRE4wzks',
  TELEGRAM_CHANNEL: '@ogbongouserartupload',
  
  // Email Configuration
  EMAIL_ENABLED: true,
  EMAIL_USER: 'bongodevem@gmail.com',
  EMAIL_PASS: process.env.EMAIL_PASSWORD || '', // Set this if you want emails
  
  // Website URL
  WEBSITE_URL: process.env.WEBSITE_URL || `http://localhost:${PORT}`
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
    telegram_message_id TEXT UNIQUE,
    image_url TEXT NOT NULL,
    artist_name TEXT DEFAULT 'Telegram Community',
    art_description TEXT DEFAULT 'Shared in our Telegram channel',
    approved_date DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Add initial sample art
  const sampleArt = [
    {
      telegram_message_id: 'welcome1',
      image_url: 'https://i.postimg.cc/vcdNBfRV/file-00000000847861f9a26eb77000b75bbb.png',
      artist_name: 'OGbongo Team',
      art_description: 'Original Bongo Character - Welcome to OGbongo!'
    },
    {
      telegram_message_id: 'welcome2', 
      image_url: 'https://i.postimg.cc/ThvzyZg1/20250806-131538.jpg',
      artist_name: 'OGbongo Team',
      art_description: 'Bongo Evolution - Join our community!'
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

// Email configuration
const createTransporter = () => {
  if (!CONFIG.EMAIL_ENABLED || !CONFIG.EMAIL_USER || !CONFIG.EMAIL_PASS) {
    console.log('📧 Email notifications disabled - no password configured');
    return null;
  }
  
  return nodemailer.createTransporter({
    service: 'gmail',
    auth: {
      user: CONFIG.EMAIL_USER,
      pass: CONFIG.EMAIL_PASS
    }
  });
};

// Telegram Bot Service
class TelegramBotService {
  constructor() {
    this.bot = null;
    this.isConnected = false;
    this.initializeBot();
  }

  initializeBot() {
    try {
      console.log('🤖 Initializing Telegram Bot...');
      this.bot = new Telegraf(CONFIG.TELEGRAM_BOT_TOKEN);
      this.setupHandlers();
      this.startBot();
    } catch (error) {
      console.error('❌ Failed to initialize Telegram bot:', error.message);
    }
  }

  setupHandlers() {
    // Listen for new messages in the channel
    this.bot.on('channel_post', async (ctx) => {
      try {
        const message = ctx.channelPost;
        console.log('📨 Received Telegram message:', message.message_id);
        
        if (message.photo) {
          await this.processTelegramImage(message);
        } else if (message.document && message.document.mime_type?.startsWith('image/')) {
          await this.processTelegramDocument(message);
        }
      } catch (error) {
        console.error('Error processing Telegram message:', error);
      }
    });

    // Handle media groups (multiple images)
    this.bot.on('media_group', async (ctx) => {
      try {
        console.log('🖼️ Processing media group...');
        const messages = ctx.mediaGroup;
        for (const message of messages) {
          if (message.photo) {
            await this.processTelegramImage(message);
          }
        }
      } catch (error) {
        console.error('Error processing media group:', error);
      }
    });
  }

  async processTelegramImage(telegramMessage) {
    try {
      const messageId = telegramMessage.message_id;
      const caption = telegramMessage.caption || 'Shared in our Telegram community';
      
      console.log(`🖼️ Processing image message ${messageId}: "${caption}"`);

      // Check if already exists
      const exists = await new Promise((resolve, reject) => {
        db.get(`SELECT id FROM approved_art WHERE telegram_message_id = ?`, [messageId], (err, row) => {
          if (err) reject(err);
          else resolve(!!row);
        });
      });

      if (exists) {
        console.log(`⏭️ Message ${messageId} already exists, skipping`);
        return;
      }

      // Get the largest available photo
      const largestPhoto = telegramMessage.photo[telegramMessage.photo.length - 1];
      const fileId = largestPhoto.file_id;

      console.log(`📸 Getting file URL for ${fileId}...`);
      const imageUrl = await this.getTelegramFileUrl(fileId);

      if (imageUrl) {
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
        
        console.log(`✅ AUTO-SYNC: Added image from Telegram`);
        console.log(`   📝 Caption: ${caption}`);
        console.log(`   🆔 Message ID: ${messageId}`);
        console.log(`   🔗 Image URL: ${imageUrl}`);
      } else {
        console.log('❌ Failed to get image URL from Telegram');
      }

    } catch (error) {
      console.error('Error processing Telegram image:', error.message);
    }
  }

  async getTelegramFileUrl(fileId) {
    try {
      const fileLink = await this.bot.telegram.getFileLink(fileId);
      return fileLink.href;
    } catch (error) {
      console.error('Error getting file URL:', error);
      return null;
    }
  }

  async processTelegramDocument(telegramMessage) {
    try {
      const messageId = telegramMessage.message_id;
      const caption = telegramMessage.caption || 'Shared in our Telegram community';
      const fileId = telegramMessage.document.file_id;

      console.log(`📄 Processing document message ${messageId}`);

      // Check if already exists
      const exists = await new Promise((resolve, reject) => {
        db.get(`SELECT id FROM approved_art WHERE telegram_message_id = ?`, [messageId], (err, row) => {
          if (err) reject(err);
          else resolve(!!row);
        });
      });

      if (exists) return;

      const fileUrl = await this.getTelegramFileUrl(fileId);
      
      if (fileUrl) {
        const stmt = db.prepare(`INSERT INTO approved_art 
          (telegram_message_id, image_url, artist_name, art_description) 
          VALUES (?, ?, ?, ?)`);
        
        await new Promise((resolve, reject) => {
          stmt.run([messageId, fileUrl, 'Telegram Community', caption], function(err) {
            if (err) reject(err);
            else resolve();
          });
        });

        stmt.finalize();
        
        console.log(`✅ AUTO-SYNC: Added document image from Telegram - "${caption}"`);
      }

    } catch (error) {
      console.error('Error processing Telegram document:', error.message);
    }
  }

  async startBot() {
    try {
      await this.bot.launch();
      this.isConnected = true;
      console.log('🎉 Telegram Bot connected and listening!');
      console.log(`📺 Monitoring channel: ${CONFIG.TELEGRAM_CHANNEL}`);
      
      // Enable graceful stop
      process.once('SIGINT', () => this.bot.stop('SIGINT'));
      process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
      
    } catch (error) {
      console.error('❌ Failed to start Telegram bot:', error.message);
      console.log('🔧 Please check:');
      console.log('   - Bot token is correct');
      console.log('   - Bot is added to channel as admin');
      console.log('   - Privacy mode is disabled in @BotFather');
    }
  }
}

// Routes

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Submit artwork from website
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

    // Send email notification
    if (CONFIG.EMAIL_ENABLED && CONFIG.EMAIL_PASS) {
      try {
        const transporter = createTransporter();
        if (transporter) {
          const mailOptions = {
            from: CONFIG.EMAIL_USER,
            to: CONFIG.EMAIL_USER,
            subject: `🎨 New OGbongo Art Submission from ${artist_name}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #6a11cb; text-align: center;">New Art Submission! 🎨</h2>
                
                <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0;">
                  <h3>Artist Information</h3>
                  <p><strong>Name:</strong> ${artist_name}</p>
                  ${artist_social ? `<p><strong>Social Media:</strong> ${artist_social}</p>` : ''}
                  ${art_description ? `<p><strong>Description:</strong> ${art_description}</p>` : ''}
                  <p><strong>Number of Images:</strong> ${req.files.length}</p>
                  <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
                </div>

                <div style="text-align: center; margin-top: 30px;">
                  <p><em>The artwork has been received and stored in the system.</em></p>
                </div>
                
                <div style="margin-top: 30px; padding: 15px; background: linear-gradient(to right, #6a11cb, #2575fc); color: white; border-radius: 8px; text-align: center;">
                  <p><strong>OGbongo - The Rhythm of a Nation</strong></p>
                </div>
              </div>
            `
          };

          await transporter.sendMail(mailOptions);
          console.log(`📧 Email notification sent for submission from ${artist_name}`);
        }
      } catch (emailError) {
        console.log('❌ Email not sent:', emailError.message);
      }
    } else {
      console.log('📧 Email notification skipped (no password configured)');
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

// Get approved artwork for gallery
app.get('/api/gallery', (req, res) => {
  db.all(`SELECT * FROM approved_art ORDER BY approved_date DESC`, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
});

// Get Telegram bot status
app.get('/api/telegram-status', (req, res) => {
  const status = {
    bot_connected: telegramService.isConnected,
    channel: CONFIG.TELEGRAM_CHANNEL,
    auto_sync: true,
    last_checked: new Date().toISOString()
  };
  res.json(status);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    features: {
      telegram_auto_sync: telegramService.isConnected,
      email_notifications: !!CONFIG.EMAIL_PASS,
      user_uploads: true
    }
  });
});

// Error handling
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

// Initialize Telegram service
const telegramService = new TelegramBotService();

app.listen(PORT, () => {
  console.log(`\n🎉 OGbongo Website Fully Configured!`);
  console.log(`=========================================`);
  console.log(`🌐 Website: http://localhost:${PORT}`);
  console.log(`📺 Telegram: ${CONFIG.TELEGRAM_CHANNEL}`);
  console.log(`🤖 Bot: @OGbongoGalleryBot`);
  console.log(`📧 Email: ${CONFIG.EMAIL_USER}`);
  console.log(`=========================================`);
  console.log(`🚀 Telegram Auto-sync: ${telegramService.isConnected ? 'ACTIVE 🟢' : 'INACTIVE 🔴'}`);
  console.log(`📧 Email Notifications: ${CONFIG.EMAIL_PASS ? 'ACTIVE 🟢' : 'INACTIVE (set EMAIL_PASSWORD) 🔴'}`);
  
  if (!telegramService.isConnected) {
    console.log('\n🔧 Telegram Bot Setup Required:');
    console.log('1. Add @OGbongoGalleryBot to your channel as ADMIN');
    console.log('2. Disable privacy mode in @BotFather');
    console.log('3. Restart the server');
  }
  
  if (!CONFIG.EMAIL_PASS) {
    console.log('\n📧 To enable email notifications:');
    console.log('   Set EMAIL_PASSWORD environment variable');
    console.log('   Example: export EMAIL_PASSWORD=your_gmail_app_password');
  }
  
  console.log('\n✅ System is running! Post images to Telegram channel to test auto-sync.');
});
