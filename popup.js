let selectedVideo = null;
let currentIteration = 0;
let cachedFrames = null;
const MAX_ITERATIONS = 3;

let GEMINI_API_KEY = null;

if (typeof GEMINI_API_KEY_CONFIG !== 'undefined' && GEMINI_API_KEY_CONFIG) {
  const key = String(GEMINI_API_KEY_CONFIG).trim();
  if (key && key !== 'your_api_key_here' && key.length > 10) {
    GEMINI_API_KEY = key;
    console.log('API key loaded successfully');
  } else {
    console.warn('API key appears to be placeholder or invalid');
  }
} else {
  console.warn('GEMINI_API_KEY_CONFIG not found. Make sure config.js is loaded before popup.js');
}

document.getElementById('uploadBtn').addEventListener('click', () => {
  document.getElementById('videoInput').click();
});

document.getElementById('videoInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    selectedVideo = file;
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('videoInfo').style.display = 'block';
  }
});

document.getElementById('processBtn').addEventListener('click', async () => {
  if (!selectedVideo) return;
  
  if (document.getElementById('processBtn').disabled) {
    return;
  }
  
  document.getElementById('processBtn').disabled = true;
  
  try {
    currentIteration = 0;
    await processVideo(selectedVideo);
  } finally {
    document.getElementById('processBtn').disabled = false;
  }
});

document.getElementById('continueBtn').addEventListener('click', async () => {
  if (!selectedVideo) return;
  await processVideo(selectedVideo, true);
});

async function processVideo(videoFile, isContinuation = false) {
  try {
    console.log('[STEP 1] Starting video processing...', { isContinuation, iteration: currentIteration });
    
    document.getElementById('status').style.display = 'block';
    document.getElementById('progress').style.display = 'block';
    document.getElementById('results').style.display = 'none';
    document.getElementById('videoInfo').style.display = 'none';
    
    let frames;
    if (isContinuation && cachedFrames) {
      console.log('[STEP 2] Using cached frames from previous iteration');
      frames = cachedFrames;
      console.log(`[STEP 2 COMPLETE] Using ${frames.length} cached frames`);
      updateProgress(30, 'Analyzing video with Gemini...');
    } else {
      updateStatus('Extracting frames from video...');
      updateProgress(10, 'Extracting frames...');
      console.log('[STEP 2] Extracting frames from video...');
      
      frames = await extractFrames(videoFile);
      cachedFrames = frames;
      console.log(`[STEP 2 COMPLETE] Extracted ${frames.length} frames from video`);
      updateProgress(30, 'Analyzing video with Gemini...');
    }
    
    console.log('[STEP 3] Checking API key...');
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_api_key_here') {
      if (typeof GEMINI_API_KEY_CONFIG !== 'undefined' && GEMINI_API_KEY_CONFIG) {
        const key = String(GEMINI_API_KEY_CONFIG).trim();
        if (key && key !== 'your_api_key_here' && key.length > 10) {
          GEMINI_API_KEY = key;
        }
      }
      
      if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_api_key_here') {
        const keyResponse = await chrome.runtime.sendMessage({ action: 'getApiKey' });
        if (keyResponse && keyResponse.apiKey && keyResponse.apiKey !== 'your_api_key_here') {
          GEMINI_API_KEY = keyResponse.apiKey;
        } else {
          throw new Error('API key not configured. Please edit config.js and add your Gemini API key. See README.md for instructions.');
        }
      }
    }
    console.log('[STEP 3 COMPLETE] API key configured');
    
    updateStatus('Generating website code...');
    updateProgress(50, 'Generating code...');
    console.log('[STEP 4] Sending frames to Gemini API for code generation...');
    
    let previousScreenshot = null;
    let previousFeedback = null;
    let previousSummary = null;
    if (isContinuation) {
      const storage = await chrome.storage.local.get(['lastScreenshot', 'lastFeedback', 'lastSummary']);
      previousScreenshot = storage.lastScreenshot;
      previousFeedback = storage.lastFeedback;
      previousSummary = storage.lastSummary;
    }
    
    const response = await chrome.runtime.sendMessage({
      action: 'processVideo',
      frames: frames,
      apiKey: GEMINI_API_KEY,
      iteration: isContinuation ? currentIteration + 1 : 0,
      previousCode: isContinuation ? await getPreviousCode() : null,
      previousScreenshot: previousScreenshot,
      previousFeedback: previousFeedback,
      previousSummary: previousSummary
    });
    
    if (response.error) {
      throw new Error(response.error);
    }
    
    console.log('[STEP 4 COMPLETE] Code generated successfully');
    console.log('[STEP 5] Creating website from generated code...');
    updateProgress(70, 'Creating website...');
    updateStatus('Creating website preview...');
    
    const tabId = await createWebsiteFromCode(response.code);
    console.log(`[STEP 5 COMPLETE] Website created in tab ${tabId}`);
    
    updateProgress(90, 'Analyzing website...');
    console.log('[STEP 6] Waiting for page to fully load and render...');
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => {
          return new Promise((resolve) => {
            if (document.readyState === 'complete') {
              setTimeout(resolve, 1000);
            } else {
              window.addEventListener('load', () => setTimeout(resolve, 1000));
            }
          });
        }
      });
    } catch (e) {
      console.warn('[STEP 6] Could not wait for page load, continuing anyway:', e);
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('[STEP 7] Taking snapshot of generated website...');
    const snapshot = await takeSnapshot(tabId);
    
    if (snapshot && snapshot.screenshot) {
      console.log('[STEP 7 COMPLETE] Snapshot captured successfully');
      await chrome.storage.local.set({ lastScreenshot: snapshot.screenshot });
    } else {
      console.warn('[STEP 7] Warning: Snapshot capture failed - will use default similarity');
    }
    
    console.log('[STEP 8] Checking for console errors...');
    const errors = await checkConsoleErrors(tabId);
    if (errors.length > 0) {
      console.warn(`[STEP 8] Found ${errors.length} console errors:`, errors);
    } else {
      console.log('[STEP 8 COMPLETE] No console errors found');
    }
    
    updateProgress(95, 'Comparing website with video...');
    console.log('[STEP 9] Comparing website with video frames using Gemini...');
    const analysis = await compareWithVideo(snapshot, frames);
    const similarity = analysis.similarity || 0.5;
    const similarityPercent = (similarity * 100).toFixed(1);
    console.log(`[STEP 9 COMPLETE] Similarity score: ${similarityPercent}%`);
    console.log(`[compareWithVideo] Current similarity: ${similarityPercent}%`);
    
    const hasFeedback = analysis.feedback && analysis.feedback.length > 0;
    if (hasFeedback) {
      console.log(`[compareWithVideo] Feedback (${analysis.feedback.length} items):`, analysis.feedback);
      await chrome.storage.local.set({ lastFeedback: analysis.feedback, lastSummary: analysis.summary });
    }
    if (analysis.summary) {
      console.log(`[compareWithVideo] Summary: ${analysis.summary}`);
    }
    
    currentIteration++;
    
    const shouldContinue = currentIteration < MAX_ITERATIONS && (hasFeedback || similarity <= 0.95);
    
    if (!shouldContinue) {
      updateProgress(100, 'Complete!');
      console.log(`[FINAL] Processing complete. Iterations: ${currentIteration}, Similarity: ${similarityPercent}%`);
      document.getElementById('status').style.display = 'none';
      document.getElementById('progress').style.display = 'none';
      document.getElementById('results').style.display = 'block';
      
      const resultMsg = currentIteration >= MAX_ITERATIONS 
        ? `Completed ${MAX_ITERATIONS} iterations. Similarity: ${similarityPercent}%`
        : `Website generated successfully! Similarity: ${similarityPercent}%`;
      
      document.getElementById('resultText').textContent = resultMsg;
      
      await saveCode(response.code);
    } else {
      console.log(`[ITERATION ${currentIteration}/${MAX_ITERATIONS}] Similarity ${similarityPercent}% - continuing refinement...`);
      if (hasFeedback) {
        console.log(`[ITERATION ${currentIteration}/${MAX_ITERATIONS}] Feedback received - will refine based on feedback`);
      }
      updateStatus(`Iteration ${currentIteration}/${MAX_ITERATIONS}. Refining...`);
      updateProgress(0, `Similarity: ${similarityPercent}%. Refining...`);
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      await processVideo(selectedVideo, true);
    }
    
  } catch (error) {
    console.error('[ERROR] Error processing video:', error);
    document.getElementById('statusText').textContent = `Error: ${error.message}`;
    document.getElementById('progress').style.display = 'none';
  }
}

async function extractFrames(videoFile) {
  console.log('[extractFrames] Starting frame extraction...');
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const frames = [];
    const targetFrames = 25;
    console.log(`[extractFrames] Target: ${targetFrames} frames`);
    
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    
    let metadataLoaded = false;
    let errorOccurred = false;
    
    video.onloadedmetadata = () => {
      if (metadataLoaded) return;
      metadataLoaded = true;
      
      if (!video.duration || video.duration === 0 || isNaN(video.duration)) {
        reject(new Error('Invalid video duration. The video may be corrupted or not fully loaded.'));
        return;
      }
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const frameInterval = Math.max(0.5, video.duration / targetFrames);
      
      let currentTime = 0;
      let lastFrameTime = -1;
      let isCapturingFinalFrame = false;
      let isComplete = false;
      
      const finishExtraction = () => {
        if (isComplete) return;
        isComplete = true;
        console.log(`[extractFrames] Extraction complete. Captured ${frames.length} frames`);
        URL.revokeObjectURL(videoUrl);
        resolve(frames);
      };
      
      const captureFrame = () => {
        if (errorOccurred || isComplete) return;
        
        if (currentTime >= video.duration - 0.1) {
          if (!isCapturingFinalFrame && (frames.length === 0 || frames[frames.length - 1].time < video.duration - 0.5)) {
            isCapturingFinalFrame = true;
            video.currentTime = Math.max(0, video.duration - 0.1);
            return;
          } else {
            finishExtraction();
            return;
          }
        }
        
        video.currentTime = currentTime;
      };
      
      video.onseeked = () => {
        if (errorOccurred || isComplete) return;
        
        const actualTime = video.currentTime;
        
        if (isCapturingFinalFrame || (currentTime - lastFrameTime >= 0.3)) {
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = canvas.toDataURL('image/png');
            const frameTime = isCapturingFinalFrame ? video.duration : currentTime;
            frames.push({
              time: frameTime,
              image: imageData,
              timestamp: frameTime
            });
            lastFrameTime = currentTime;
            
            if (isCapturingFinalFrame) {
              finishExtraction();
              return;
            }
          } catch (e) {
            console.error('Error drawing frame:', e);
          }
        }
        
        if (!isCapturingFinalFrame && currentTime < video.duration - 0.1) {
          currentTime += frameInterval;
          
          if (currentTime < video.duration - 0.1) {
            captureFrame();
          } else {
            isCapturingFinalFrame = true;
            video.currentTime = Math.max(0, video.duration - 0.1);
          }
        }
      };
      
      video.onloadeddata = () => {
        captureFrame();
      };
      
      captureFrame();
    };
    
    video.onerror = (e) => {
      errorOccurred = true;
      const errorMsg = video.error ? 
        `Code: ${video.error.code}, Message: ${video.error.message}` : 
        'Unknown error';
      reject(new Error('Failed to load video: ' + errorMsg));
    };
    
    const videoUrl = URL.createObjectURL(videoFile);
    video.src = videoUrl;
    
    video.addEventListener('ended', () => {
      URL.revokeObjectURL(videoUrl);
    });
    
    setTimeout(() => {
      if (frames.length === 0 && !errorOccurred) {
        errorOccurred = true;
        reject(new Error('Frame extraction timeout. The video may be too long or corrupted.'));
      }
    }, 30000);
  });
}

function injectCSSAndJS(htmlContent, css, js, nonce) {
  console.log('[injectCSSAndJS] Starting injection...');
  console.log('[injectCSSAndJS] CSS provided:', !!css, 'Length:', css?.length || 0);
  console.log('[injectCSSAndJS] JS provided:', !!js, 'Length:', js?.length || 0);
  console.log('[injectCSSAndJS] HTML already has <style>?', htmlContent.includes('<style>'));
  console.log('[injectCSSAndJS] HTML already has <script>?', htmlContent.includes('<script>'));
  
  if (htmlContent.includes('<style>')) {
    htmlContent = htmlContent.replace(/<style>[\s\S]*?<\/style>/gi, '');
    console.log('[injectCSSAndJS] Removed existing <style> tag');
  }
  
  if (css && css.trim()) {
    const styleTag = `<style>${css}</style>`;
    if (htmlContent.includes('</head>')) {
      htmlContent = htmlContent.replace('</head>', `${styleTag}</head>`);
      console.log('[injectCSSAndJS] Injected CSS before </head>');
    } else if (htmlContent.includes('<head>')) {
      htmlContent = htmlContent.replace('<head>', `<head>${styleTag}`);
      console.log('[injectCSSAndJS] Injected CSS after <head>');
    } else {
      htmlContent = htmlContent.replace('<html>', `<html><head>${styleTag}</head>`);
      console.log('[injectCSSAndJS] Injected CSS in new <head>');
    }
  } else {
    console.warn('[injectCSSAndJS] No CSS to inject or CSS is empty');
  }
  
  if (htmlContent.includes('<script>')) {
    htmlContent = htmlContent.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
    console.log('[injectCSSAndJS] Removed existing <script> tag');
  }
  
  if (js && js.trim()) {
    const scriptTag = `<script nonce="${nonce}">${js}</script>`;
    if (htmlContent.includes('</body>')) {
      htmlContent = htmlContent.replace('</body>', `${scriptTag}</body>`);
      console.log('[injectCSSAndJS] Injected JS before </body>');
    } else if (htmlContent.includes('<body>')) {
      htmlContent = htmlContent.replace('<body>', `<body>${scriptTag}`);
      console.log('[injectCSSAndJS] Injected JS after <body>');
    } else {
      htmlContent = htmlContent.replace('</html>', `${scriptTag}</html>`);
      console.log('[injectCSSAndJS] Injected JS before </html>');
    }
  } else {
    console.warn('[injectCSSAndJS] No JS to inject or JS is empty');
  }
  
  console.log('[injectCSSAndJS] Final HTML has <style>?', htmlContent.includes('<style>'));
  console.log('[injectCSSAndJS] Final HTML has <script>?', htmlContent.includes('<script>'));
  
  return htmlContent;
}

async function createWebsiteFromCode(codeFiles) {
  console.log('[createWebsiteFromCode] Building HTML from generated code...');
  const nonce = btoa(Math.random().toString(36)).substring(0, 16);
  const SERVER_URL = 'http://localhost:8765';
  
  if (codeFiles.pages && Array.isArray(codeFiles.pages)) {
    console.log(`[createWebsiteFromCode] Multi-page format detected: ${codeFiles.pages.length} pages`);
    const pageNames = codeFiles.pages.map(p => p.name || 'index.html').join(', ');
    console.log(`[createWebsiteFromCode] Pages detected: ${pageNames}`);
    console.log(`[createWebsiteFromCode] CSS length: ${codeFiles.css?.length || 0} chars, JS length: ${codeFiles.js?.length || 0} chars`);
    console.log(`[createWebsiteFromCode] CSS preview: ${codeFiles.css?.substring(0, 100) || 'NONE'}...`);
    console.log(`[createWebsiteFromCode] JS preview: ${codeFiles.js?.substring(0, 100) || 'NONE'}...`);
    
    const processedPages = codeFiles.pages.map((page, index) => {
      console.log(`[createWebsiteFromCode] Processing page ${index + 1}: ${page.name}`);
      console.log(`[createWebsiteFromCode] Page HTML length: ${page.html?.length || 0} chars`);
      const processed = injectCSSAndJS(page.html, codeFiles.css, codeFiles.js, nonce);
      console.log(`[createWebsiteFromCode] Page ${index + 1} processed, final HTML length: ${processed.length} chars`);
      return {
        name: page.name || 'index.html',
        html: processed
      };
    });
    
    console.log('[createWebsiteFromCode] Updating local server with multiple pages...');
    try {
      const response = await fetch(`${SERVER_URL}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pages: processedPages })
      });
      
      if (!response.ok) {
        throw new Error('Failed to update local server');
      }
      const result = await response.json();
      console.log(`[createWebsiteFromCode] Server updated successfully with ${processedPages.length} pages`);
      console.log(`[createWebsiteFromCode] Available pages: ${result.pages?.join(', ') || pageNames}`);
      console.log(`[createWebsiteFromCode] Access pages at: ${SERVER_URL}/index.html, ${SERVER_URL}/cool.html, etc.`);
    } catch (error) {
      console.error('[createWebsiteFromCode] Error updating local server:', error);
      throw new Error('Local server not running. Please start the server by running: node server.js');
    }
  }
  else {
    let htmlContent = codeFiles.html || '<!DOCTYPE html><html><head><title>Generated Website</title></head><body></body></html>';
    console.log(`[createWebsiteFromCode] Single-page format detected (no multiple pages found in video)`);
    console.log(`[createWebsiteFromCode] HTML length: ${htmlContent.length} chars, CSS length: ${codeFiles.css?.length || 0} chars, JS length: ${codeFiles.js?.length || 0} chars`);
    
    htmlContent = injectCSSAndJS(htmlContent, codeFiles.css, codeFiles.js, nonce);
    
    console.log('[createWebsiteFromCode] Updating local server with generated HTML...');
    try {
      const response = await fetch(`${SERVER_URL}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ html: htmlContent })
      });
      
      if (!response.ok) {
        throw new Error('Failed to update local server');
      }
      console.log('[createWebsiteFromCode] Server updated successfully');
    } catch (error) {
      console.error('[createWebsiteFromCode] Error updating local server:', error);
      throw new Error('Local server not running. Please start the server by running: node server.js');
    }
  }
  
  console.log('[createWebsiteFromCode] Finding active tab...');
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
    if (activeTab && activeTab.id) {
      let startingUrl = SERVER_URL;
      if (codeFiles.pages && Array.isArray(codeFiles.pages) && codeFiles.pages.length > 0 && codeFiles.startingPage) {
        startingUrl = `${SERVER_URL}/${codeFiles.startingPage}`;
        console.log(`[createWebsiteFromCode] Multiple pages detected - starting at page: ${codeFiles.startingPage}`);
      } else {
        console.log(`[createWebsiteFromCode] Single page or no startingPage - starting at base URL: ${SERVER_URL}`);
      }
      
      let updateDelay = 800;
      try {
        const currentWindow = await chrome.windows.getCurrent();
        if (currentWindow.type === 'popup') {
          updateDelay = 1000;
          console.log(`[createWebsiteFromCode] Popup detected - using ${updateDelay}ms delay to prevent popup from closing`);
        } else {
          updateDelay = 600;
          console.log(`[createWebsiteFromCode] Regular window detected - using ${updateDelay}ms delay`);
        }
      } catch (error) {
        console.warn('[createWebsiteFromCode] Could not check window type, using default delay:', error);
        updateDelay = 800;
      }
      
      console.log(`[createWebsiteFromCode] Updating tab ${activeTab.id} to ${startingUrl} (using ${updateDelay}ms async update to keep popup open)`);
      
      requestAnimationFrame(() => {
        setTimeout(() => {
          chrome.tabs.update(activeTab.id, { 
            url: startingUrl,
            active: false
          }).catch(err => console.error('[createWebsiteFromCode] Error updating tab:', err));
        }, updateDelay);
      });
      
      console.log('[createWebsiteFromCode] Waiting for page to start loading...');
      await new Promise(resolve => setTimeout(resolve, 500));
      
      let pageLoaded = false;
      let attempts = 0;
      while (!pageLoaded && attempts < 10) {
        attempts++;
        try {
          const updatedTab = await chrome.tabs.get(activeTab.id);
          if (updatedTab.status === 'complete' && (updatedTab.url === startingUrl || updatedTab.url.startsWith(SERVER_URL))) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const hasContent = await chrome.scripting.executeScript({
              target: { tabId: activeTab.id },
              func: () => {
                const body = document.body;
                if (!body) return false;
                const hasChildren = body.children.length > 0;
                const hasText = body.textContent.trim().length > 0;
                const computedStyle = window.getComputedStyle(body);
                const bgColor = computedStyle.backgroundColor;
                const isBlack = bgColor === 'rgb(0, 0, 0)' || bgColor === 'black' || bgColor === 'rgba(0, 0, 0, 0)';
                return hasChildren || (hasText && !isBlack);
              }
            });
            
            if (hasContent && hasContent[0] && hasContent[0].result) {
              pageLoaded = true;
              console.log('[createWebsiteFromCode] Page loaded with content');
            } else {
              console.log(`[createWebsiteFromCode] Page not ready yet (attempt ${attempts}/10), waiting...`);
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          } else {
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        } catch (e) {
          console.warn(`[createWebsiteFromCode] Check attempt ${attempts} failed:`, e);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      if (!pageLoaded) {
        console.warn('[createWebsiteFromCode] Page may not be fully loaded, but proceeding...');
      }
      
      await chrome.storage.local.set({
        [`website_${activeTab.id}`]: codeFiles
      });
      
      return activeTab.id;
    }
  
  console.log('[createWebsiteFromCode] Creating new tab...');
  const tab = await chrome.tabs.create({ 
    url: SERVER_URL,
    active: true
  });
  
  await chrome.storage.local.set({
    [`website_${tab.id}`]: codeFiles
  });
  
  return tab.id;
}

let lastScreenshotTime = 0;
const SCREENSHOT_COOLDOWN = 2000;

async function takeSnapshot(tabId) {
  try {
    console.log(`[takeSnapshot] Attempting to capture screenshot of tab ${tabId}...`);
    
    const timeSinceLastScreenshot = Date.now() - lastScreenshotTime;
    if (timeSinceLastScreenshot < SCREENSHOT_COOLDOWN) {
      const waitTime = SCREENSHOT_COOLDOWN - timeSinceLastScreenshot;
      console.log(`[takeSnapshot] Waiting ${waitTime}ms to avoid rate limit...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    let screenshot = null;
    let tab = null;
    
    try {
      tab = await chrome.tabs.get(tabId);
      if (!tab) {
        throw new Error(`Tab ${tabId} not found`);
      }
      console.log(`[takeSnapshot] Tab found: ${tab.url}, window: ${tab.windowId}, active: ${tab.active}`);
    } catch (e) {
      console.error(`[takeSnapshot] Could not get tab ${tabId}:`, e);
      return { screenshot: null, dom: null, timestamp: Date.now() };
    }
    
    if (!tab.active) {
      console.log('[takeSnapshot] Activating tab...');
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('[takeSnapshot] Waiting for page to fully render...');
    let pageReady = false;
    let readyAttempts = 0;
    const maxReadyAttempts = 15;
    
    while (!pageReady && readyAttempts < maxReadyAttempts) {
      readyAttempts++;
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: () => {
            const body = document.body;
            if (!body) return { ready: false, reason: 'no body' };
            
            const computedStyle = window.getComputedStyle(body);
            const bgColor = computedStyle.backgroundColor;
            const hasContent = body.children.length > 0 || body.textContent.trim().length > 0;
            const isBlack = bgColor === 'rgb(0, 0, 0)' || bgColor === 'black' || bgColor === 'rgba(0, 0, 0, 0)';
            const imagesLoaded = Array.from(document.images).every(img => img.complete);
            const readyState = document.readyState === 'complete';
            
            return {
              ready: readyState && hasContent && !isBlack && imagesLoaded,
              readyState: document.readyState,
              hasContent: hasContent,
              isBlack: isBlack,
              bgColor: bgColor,
              imagesLoaded: imagesLoaded,
              childrenCount: body.children.length
            };
          }
        });
        
        if (result && result[0] && result[0].result) {
          const status = result[0].result;
          if (status.ready) {
            pageReady = true;
            console.log('[takeSnapshot] Page is ready for screenshot');
          } else {
            if (status.isBlack) {
              console.log(`[takeSnapshot] Page appears black (attempt ${readyAttempts}/${maxReadyAttempts}), waiting...`);
            } else if (!status.hasContent) {
              console.log(`[takeSnapshot] Page has no content (attempt ${readyAttempts}/${maxReadyAttempts}), waiting...`);
            } else if (!status.imagesLoaded) {
              console.log(`[takeSnapshot] Images still loading (attempt ${readyAttempts}/${maxReadyAttempts}), waiting...`);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } else {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (e) {
        console.warn(`[takeSnapshot] Page check attempt ${readyAttempts} failed:`, e);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    if (!pageReady) {
      console.warn('[takeSnapshot] Page may not be fully ready after multiple checks, proceeding anyway...');
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[takeSnapshot] Screenshot attempt ${attempt}/${maxAttempts}...`);
        const windowId = tab.windowId;
        screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        lastScreenshotTime = Date.now();
        console.log(`[takeSnapshot] Screenshot captured successfully on attempt ${attempt}`);
        break;
      } catch (screenshotError) {
        console.warn(`[takeSnapshot] Attempt ${attempt} failed:`, screenshotError.message);
        
        if (attempt < maxAttempts) {
          const waitTime = screenshotError.message?.includes('MAX_CAPTURE') ? 3000 : 2000;
          console.log(`[takeSnapshot] Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          console.warn('[takeSnapshot] All screenshot attempts failed - continuing without screenshot');
          screenshot = null;
        }
      }
    }
    
    if (screenshot) {
      console.log('[takeSnapshot] Screenshot captured');
      console.log('[takeSnapshot] Screenshot URL:', screenshot);
    } else {
      console.warn('[takeSnapshot] No screenshot captured');
    }
    
    console.log('[takeSnapshot] Getting DOM snapshot...');
    let domSnapshot = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => {
          return {
            html: document.documentElement.outerHTML,
            url: window.location.href,
            title: document.title
          };
        }
      });
      if (results && results[0] && results[0].result) {
        domSnapshot = results[0].result;
        console.log('[takeSnapshot] DOM snapshot captured');
      }
    } catch (e) {
      console.warn('[takeSnapshot] Could not get DOM snapshot:', e);
    }
    
    return {
      screenshot: screenshot,
      dom: domSnapshot,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('[takeSnapshot] Error taking snapshot:', error);
    return null;
  }
}

async function checkConsoleErrors(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const errors = [];
        const originalError = console.error;
        const originalWarn = console.warn;
        
        console.error = function(...args) {
          errors.push({ type: 'error', message: args.join(' '), timestamp: Date.now() });
          originalError.apply(console, args);
        };
        
        console.warn = function(...args) {
          errors.push({ type: 'warning', message: args.join(' '), timestamp: Date.now() });
          originalWarn.apply(console, args);
        };
        
        return errors;
      }
    });
    
    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
  } catch (e) {
    console.warn('Could not check console errors:', e);
  }
  return [];
}

async function compareWithVideo(snapshot, videoFrames) {
  console.log('[compareWithVideo] Starting Gemini-based similarity analysis...');
  
  if (!videoFrames || videoFrames.length === 0) {
    console.warn('[compareWithVideo] No video frames available, returning default similarity 0.5');
    return { similarity: 0.5, feedback: [], summary: 'No video frames available' };
  }
  
  if (!snapshot || !snapshot.screenshot) {
    console.warn('[compareWithVideo] No screenshot available, returning default similarity 0.5');
    return { similarity: 0.5, feedback: ['Screenshot not available for comparison'], summary: 'Screenshot capture failed' };
  }
  
  try {
    console.log('[compareWithVideo] Sending screenshot and video frames to Gemini for analysis...');
    console.log('[compareWithVideo] Screenshot length:', snapshot.screenshot?.length || 0);
    console.log('[compareWithVideo] Video frames count:', videoFrames?.length || 0);
    console.log('[compareWithVideo] API key present:', !!GEMINI_API_KEY);
    
    try {
      const pingResponse = await chrome.runtime.sendMessage({ action: 'getApiKey' });
      if (pingResponse && pingResponse.apiKey) {
        console.log('[compareWithVideo] Background script is active');
      }
    } catch (pingError) {
      console.warn('[compareWithVideo] Could not ping background script:', pingError);
    }
    
    let response;
    try {
      const messagePromise = new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'analyzeSimilarity',
          screenshot: snapshot.screenshot,
          videoFrames: videoFrames,
          apiKey: GEMINI_API_KEY
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout waiting for similarity analysis response (120s)')), 120000)
      );
      
      response = await Promise.race([messagePromise, timeoutPromise]);
    } catch (error) {
      console.error('[compareWithVideo] Error sending message or timeout:', error);
      if (error.message && error.message.includes('Extension context invalidated')) {
        return { similarity: 0.5, feedback: ['Extension context invalidated - please reload the extension'], summary: 'Extension needs to be reloaded' };
      }
      if (error.message && error.message.includes('Timeout')) {
        return { similarity: 0.5, feedback: ['Similarity analysis timed out - background script may be inactive'], summary: 'Analysis timed out' };
      }
      return { similarity: 0.5, feedback: [error.message || 'Failed to communicate with background script'], summary: 'Communication error' };
    }
    
    if (!response) {
      console.error('[compareWithVideo] No response from background script - response is undefined');
      console.error('[compareWithVideo] This might mean the service worker is inactive');
      return { similarity: 0.5, feedback: ['No response from similarity analysis - background script may be inactive'], summary: 'Background script did not respond' };
    }
    
    console.log('[compareWithVideo] Received response:', response);
    
    if (response.error) {
      console.error('[compareWithVideo] Error from Gemini:', response.error);
      return { similarity: 0.5, feedback: [response.error], summary: 'Analysis failed' };
    }
    
    console.log('[compareWithVideo] Gemini analysis complete');
    console.log(`[compareWithVideo] Similarity: ${(response.similarity * 100).toFixed(1)}%`);
    console.log(`[compareWithVideo] Feedback items: ${response.feedback?.length || 0}`);
    console.log('[compareWithVideo] Summary:', response.summary);
    if (response.feedback && response.feedback.length > 0) {
      console.log('[compareWithVideo] Feedback:', response.feedback);
    }
    
    return {
      similarity: response.similarity || 0.5,
      feedback: response.feedback || [],
      summary: response.summary || 'Analysis completed'
    };
  } catch (error) {
    console.error('[compareWithVideo] Error during similarity analysis:', error);
    return { similarity: 0.5, feedback: [error.message], summary: 'Analysis error occurred' };
  }
}

async function saveCode(code) {
  await chrome.storage.local.set({ previousCode: code });
}

async function getPreviousCode() {
  const { previousCode } = await chrome.storage.local.get(['previousCode']);
  return previousCode;
}

function updateStatus(text) {
  document.getElementById('statusText').textContent = text;
}

function updateProgress(percent, text) {
  document.getElementById('progressFill').style.width = `${percent}%`;
  document.getElementById('progressText').textContent = text;
}
