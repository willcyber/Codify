# Codify

Generate websites from videos using Google Gemini AI.

## Setup

### 1. API Key Configuration

1. Get your Google Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Open `config.js` in the Codify directory
3. Replace `your_api_key_here` with your actual API key:
   ```javascript
   const GEMINI_API_KEY_CONFIG = "your_actual_api_key_here";
   ```
4. Save the file

### 2. Start Local Server

The extension uses a local server to display generated websites. Start the server:

```bash
node server.js
```

Keep this server running while using the extension. The server runs on `http://localhost:8765`.

### 3. Load Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the Codify directory

**Note**: `config.js` contains a placeholder API key. You must update it with your own key before using the extension.

## Overview

Codify is a Chrome extension that analyzes videos of websites and generates functional, styled websites that match what you showed in the video. It uses Google's Gemini Pro API to understand the layout, styling, and interactions from video frames, then iteratively refines the generated website until it closely matches your video.

## Features

- 📹 **Video Analysis**: Extracts key frames from uploaded videos, focusing on interactions and navigation
- 🤖 **AI-Powered Generation**: Uses Google Gemini Pro to analyze frames and generate website code
- 🔄 **Iterative Refinement**: Automatically refines the website up to 3 times or until it reaches 95% similarity
- 🎨 **Complete Code Generation**: Generates HTML, CSS, and JavaScript files
- 🔍 **Error Detection**: Monitors console errors and automatically fixes issues
- 📸 **Visual Comparison**: Compares generated websites with video frames using screenshot analysis
- 🚀 **Live Preview**: Opens generated websites in a new tab for immediate viewing
