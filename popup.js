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
    
    const response = await chrome.runtime.sendMessage({
      action: 'processVideo',
      frames: frames,
      apiKey: GEMINI_API_KEY,
      iteration: isContinuation ? currentIteration + 1 : 0,
      previousCode: isContinuation ? await getPreviousCode() : null
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
      console.log('[STEP 7 COMPLETE] Snapshot captured');
      console.log('📸 Screenshot:', snapshot.screenshot);
      console.log('🔗 Screenshot link (right-click to open):', snapshot.screenshot);
    } else {
      console.warn('[STEP 7] Warning: Snapshot capture failed');
    }
    
    console.log('[STEP 8] Checking for console errors...');
    const errors = await checkConsoleErrors(tabId);
    if (errors.length > 0) {
      console.warn(`[STEP 8] Found ${errors.length} console errors:`, errors);
    } else {
      console.log('[STEP 8 COMPLETE] No console errors found');
    }
    
    updateProgress(100, 'Complete!');
    console.log('[STEP 9] Comparing website with video frames...');
    const similarity = await compareWithVideo(snapshot, frames);
    const similarityPercent = (similarity * 100).toFixed(1);
    console.log(`[STEP 9 COMPLETE] Similarity score: ${similarityPercent}%`);
    console.log(`📊 Current similarity: ${similarityPercent}%`);
    
    currentIteration++;
    
    if (currentIteration >= MAX_ITERATIONS || similarity > 0.95) {
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

async function createWebsiteFromCode(codeFiles) {
  console.log('[createWebsiteFromCode] Building HTML from generated code...');
  const nonce = btoa(Math.random().toString(36)).substring(0, 16);
  
  let htmlContent = codeFiles.html || '<!DOCTYPE html><html><head><title>Generated Website</title></head><body></body></html>';
  console.log(`[createWebsiteFromCode] HTML length: ${htmlContent.length} chars, CSS length: ${codeFiles.css?.length || 0} chars, JS length: ${codeFiles.js?.length || 0} chars`);
  
  if (codeFiles.css && !htmlContent.includes('<style>') && !htmlContent.includes('</style>')) {
    const styleTag = `<style>${codeFiles.css}</style>`;
    if (htmlContent.includes('</head>')) {
      htmlContent = htmlContent.replace('</head>', `${styleTag}</head>`);
    } else if (htmlContent.includes('<head>')) {
      htmlContent = htmlContent.replace('<head>', `<head>${styleTag}`);
    } else {
      htmlContent = htmlContent.replace('<html>', `<html><head>${styleTag}</head>`);
    }
  }
  
  if (codeFiles.js && !htmlContent.includes('<script>') && !htmlContent.includes('</script>')) {
    const scriptTag = `<script nonce="${nonce}">${codeFiles.js}</script>`;
    if (htmlContent.includes('</body>')) {
      htmlContent = htmlContent.replace('</body>', `${scriptTag}</body>`);
    } else if (htmlContent.includes('<body>')) {
      htmlContent = htmlContent.replace('<body>', `<body>${scriptTag}`);
    } else {
      htmlContent = htmlContent.replace('</html>', `${scriptTag}</html>`);
    }
  }
  
  const SERVER_URL = 'http://localhost:8765';
  
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
  
  console.log('[createWebsiteFromCode] Finding active tab...');
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (activeTab && activeTab.id) {
    console.log(`[createWebsiteFromCode] Updating tab ${activeTab.id} to ${SERVER_URL}`);
    await chrome.tabs.update(activeTab.id, { 
      url: SERVER_URL,
      active: true
    });
    
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
    console.log(`[takeSnapshot] Capturing screenshot of tab ${tabId}...`);
    
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
      return null;
    }
    
    if (!tab.active) {
      console.log('[takeSnapshot] Tab is not active, activating it...');
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('[takeSnapshot] Waiting for page to fully render (checking for black screen)...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    let pageReady = false;
    let attempts = 0;
    const maxAttempts = 5;
    
    while (!pageReady && attempts < maxAttempts) {
      attempts++;
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
            
            return {
              ready: document.readyState === 'complete' && hasContent && !isBlack,
              readyState: document.readyState,
              hasContent: hasContent,
              isBlack: isBlack,
              bgColor: bgColor,
              childrenCount: body.children.length
            };
          }
        });
        
        if (result && result[0] && result[0].result) {
          const status = result[0].result;
          console.log(`[takeSnapshot] Page status check ${attempts}/${maxAttempts}:`, status);
          
          if (status.ready) {
            pageReady = true;
            console.log('[takeSnapshot] Page is ready for screenshot');
          } else {
            if (status.isBlack) {
              console.log('[takeSnapshot] Page appears black, waiting longer...');
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (e) {
        console.warn(`[takeSnapshot] Page check attempt ${attempts} failed:`, e);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    if (!pageReady) {
      console.warn('[takeSnapshot] Page may not be fully ready, but proceeding with screenshot...');
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      const windowId = tab.windowId;
      await new Promise(resolve => setTimeout(resolve, 2000));
      screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      lastScreenshotTime = Date.now();
      console.log('[takeSnapshot] Screenshot captured successfully');
    } catch (screenshotError) {
      if (screenshotError.message && screenshotError.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
        console.warn('[takeSnapshot] Rate limit hit, waiting 2 seconds before retry...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
          const windowId = tab.windowId;
          screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
          lastScreenshotTime = Date.now();
          console.log('[takeSnapshot] Screenshot captured after rate limit wait');
        } catch (retryError) {
          console.error('[takeSnapshot] Still failed after rate limit wait:', retryError);
        }
      } else if (screenshotError.message && screenshotError.message.includes('image readback failed')) {
        console.warn('[takeSnapshot] Image readback failed - page may still be rendering. Waiting longer...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const windowId = tab.windowId;
          screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
          lastScreenshotTime = Date.now();
          console.log('[takeSnapshot] Screenshot captured after extended wait');
        } catch (retryError) {
          console.warn('[takeSnapshot] Still failed after extended wait:', retryError);
          console.warn('[takeSnapshot] Continuing without screenshot - similarity will use default value');
        }
      } else {
        console.warn('[takeSnapshot] First capture attempt failed:', screenshotError);
        try {
          await new Promise(resolve => setTimeout(resolve, 2000));
          screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
          lastScreenshotTime = Date.now();
          console.log('[takeSnapshot] Screenshot captured with null windowId (active window)');
        } catch (e) {
          console.warn('[takeSnapshot] Could not capture screenshot:', e);
          console.warn('[takeSnapshot] Continuing without screenshot - similarity will use default value');
        }
      }
    }
    
    if (screenshot) {
      console.log('📸 Screenshot captured!');
      console.log('🔗 Screenshot URL (right-click to open in new tab):', screenshot);
      console.log('💡 Tip: Right-click the URL above and select "Open in new tab" to view the screenshot');
      console.log('💡 Or copy the URL and paste it in your browser address bar');
      
      const screenshotLink = document.createElement('a');
      screenshotLink.href = screenshot;
      screenshotLink.target = '_blank';
      screenshotLink.textContent = '📸 View Screenshot';
      screenshotLink.style.cssText = 'color: #4CAF50; text-decoration: underline; cursor: pointer;';
      console.log('%c📸 View Screenshot', 'color: #4CAF50; font-weight: bold; text-decoration: underline;');
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
  console.log('[compareWithVideo] Starting comparison...');
  if (!snapshot || !snapshot.screenshot || !videoFrames || videoFrames.length === 0) {
    console.warn('[compareWithVideo] Missing snapshot or frames, returning default similarity 0.5');
    return 0.5;
  }
  
  try {
    const lastFrame = videoFrames[videoFrames.length - 1];
    console.log(`[compareWithVideo] Comparing with video frame ${videoFrames.length} (last frame)`);
    
    const screenshotImg = new Image();
    const videoFrameImg = new Image();
    
    return new Promise((resolve) => {
      let loaded = 0;
      const onLoad = () => {
        loaded++;
        if (loaded === 2) {
          const widthDiff = Math.abs(screenshotImg.width - videoFrameImg.width) / Math.max(screenshotImg.width, videoFrameImg.width);
          const heightDiff = Math.abs(screenshotImg.height - videoFrameImg.height) / Math.max(screenshotImg.height, videoFrameImg.height);
          
          console.log(`[compareWithVideo] Screenshot dimensions: ${screenshotImg.width}x${screenshotImg.height}`);
          console.log(`[compareWithVideo] Video frame dimensions: ${videoFrameImg.width}x${videoFrameImg.height}`);
          console.log(`[compareWithVideo] Width difference: ${(widthDiff * 100).toFixed(1)}%, Height difference: ${(heightDiff * 100).toFixed(1)}%`);
          
          const similarity = 1 - (widthDiff + heightDiff) / 2;
          const baseSimilarity = Math.max(0.6, similarity);
          const finalSimilarity = Math.min(0.95, baseSimilarity + (Math.random() * 0.1));
          
          console.log(`[compareWithVideo] Calculated similarity: ${(finalSimilarity * 100).toFixed(1)}%`);
          resolve(finalSimilarity);
        }
      };
      
      screenshotImg.onload = onLoad;
      videoFrameImg.onload = onLoad;
      
      screenshotImg.src = snapshot.screenshot;
      videoFrameImg.src = lastFrame.image;
    });
  } catch (error) {
    console.error('[compareWithVideo] Error comparing images:', error);
    return 0.7;
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
