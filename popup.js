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

document.getElementById('downloadBtn').addEventListener('click', async () => {
  await downloadCodeAsZip();
});

async function processVideo(videoFile, isContinuation = false) {
  try {
    console.log('[STEP 1] Starting video processing...', { isContinuation, iteration: currentIteration });

    if (!isContinuation) {
      // Clear state from previous runs so refinement never uses stale code/feedback
      await chrome.storage.local.remove(['previousCode', 'lastScreenshot', 'lastFeedback', 'lastSummary']);
    }

    document.getElementById('status').style.display = 'block';
    document.getElementById('progress').style.display = 'block';
    document.getElementById('results').style.display = 'none';
    document.getElementById('videoInfo').style.display = 'none';
    document.getElementById('downloadBtn').style.display = 'none';
    
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
    // Save immediately so the next refinement iteration gets this code,
    // not undefined (fresh install) or code left over from an old run.
    await saveCode(response.code);
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
    
    console.log('[STEP 7] Extracting actions from original video...');
    updateProgress(75, 'Analyzing video interactions...');
    updateStatus('Extracting user actions from video...');
    
    let actionsData = null;
    try {
      // Pass the generated code so Gemini can align dropdown selections
      // with the actual <option> values in the HTML it produced.
      actionsData = await extractActionsFromVideo(frames, response.code);
      console.log('[STEP 7 COMPLETE] Extracted', actionsData.actions?.length || 0, 'actions');
    } catch (error) {
      console.warn('[STEP 7] Failed to extract actions, continuing without automated interactions:', error);
    }
    
    console.log('[STEP 8] Performing automated interactions with video recording...');
    updateProgress(80, 'Performing interactions...');
    updateStatus('Automating website interactions...');
    
    const videoDuration = actionsData?.videoDuration || 30;
    let recordedFrames = [];
    
    if (actionsData && actionsData.actions && actionsData.actions.length > 0) {
      try {
        recordedFrames = await performAutomatedInteractionsWithRecording(tabId, actionsData.actions, videoDuration);
        console.log('[STEP 8 COMPLETE] Automated interactions completed');
        console.log('[STEP 8 COMPLETE] Recorded', recordedFrames.length, 'frames during interactions');
      } catch (error) {
        console.error('[STEP 8] Error during automated interactions:', error);
        console.error('[STEP 8] Stopping video recording and showing error');
        throw error;
      }
    } else {
      console.log('[STEP 8] No actions to perform, skipping interactions');
    }
    
    console.log('[STEP 9] Comparing recorded video with original...');
    updateProgress(95, 'Comparing website with video...');
    updateStatus('Comparing website with video...');
    
    let analysis;
    if (recordedFrames.length > 0) {
      try {
        analysis = await compareVideos(recordedFrames, frames);
        const similarity = analysis.similarity || 0.5;
        const similarityPercent = (similarity * 100).toFixed(1);
        console.log(`[STEP 9 COMPLETE] Similarity score: ${similarityPercent}%`);
      } catch (error) {
        console.error('[STEP 9] Error comparing videos:', error);
        console.error('[STEP 9] Falling back to screenshot comparison');
        const snapshot = await takeSnapshot(tabId);
        analysis = await compareWithVideo(snapshot, frames);
        const similarity = analysis.similarity || 0.5;
        const similarityPercent = (similarity * 100).toFixed(1);
        console.log(`[STEP 9 COMPLETE] Similarity score: ${similarityPercent}%`);
      }
    } else {
      console.error('[STEP 9] No recorded frames, falling back to screenshot comparison');
      const snapshot = await takeSnapshot(tabId);
      analysis = await compareWithVideo(snapshot, frames);
      const similarity = analysis.similarity || 0.5;
      const similarityPercent = (similarity * 100).toFixed(1);
      console.log(`[STEP 9 COMPLETE] Similarity score: ${similarityPercent}%`);
    }
    
    const similarity = analysis.similarity || 0.5;
    const similarityPercent = (similarity * 100).toFixed(1);
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
      document.getElementById('downloadBtn').style.display = 'block';
      
      await saveCode(response.code);
      await saveCodeForDownload(response.code);
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
      
      const currentUrl = activeTab.url || '';
      const isAlreadyOnUrl = currentUrl === startingUrl || currentUrl.startsWith(startingUrl + '?') || currentUrl.startsWith(startingUrl + '#');
      
      if (!isAlreadyOnUrl) {
        console.log(`[createWebsiteFromCode] Navigating to ${startingUrl} using script injection to prevent popup from closing...`);
        
        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: (url) => {
              window.location.href = url;
            },
            args: [startingUrl]
          });
          console.log('[createWebsiteFromCode] Navigation script injected successfully');
        } catch (error) {
          console.warn('[createWebsiteFromCode] Script injection failed, falling back to tabs.update:', error);
          requestAnimationFrame(() => {
            setTimeout(() => {
              chrome.tabs.update(activeTab.id, { 
                url: startingUrl,
                active: false
              }).catch(err => console.error('[createWebsiteFromCode] Error updating tab:', err));
            }, 500);
          });
        }
        
        console.log('[createWebsiteFromCode] Waiting for page to start loading...');
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        console.log(`[createWebsiteFromCode] Tab is already on ${startingUrl}, no navigation needed`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
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

async function extractActionsFromVideo(frames, code) {
  try {
    console.log('[extractActionsFromVideo] Extracting actions from', frames.length, 'frames');
    updateStatus('Analyzing video for interactions...');
    
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for action extraction response (120s)'));
      }, 120000);
      
      chrome.runtime.sendMessage({
        action: 'extractActions',
        frames: frames,
        code: code || null,
        apiKey: GEMINI_API_KEY
      }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
    
    if (response.error) {
      throw new Error(response.error);
    }
    
    console.log('[extractActionsFromVideo] Extracted', response.actions?.length || 0, 'actions');
    return response;
  } catch (error) {
    console.error('[extractActionsFromVideo] Error:', error);
    throw error;
  }
}

async function performAutomatedInteractions(tabId, actions, videoDuration) {
  try {
    console.log('[performAutomatedInteractions] Starting interactions on tab', tabId);
    console.log('[performAutomatedInteractions] Actions to perform:', actions.length);
    
    await chrome.debugger.attach({ tabId }, "1.0");
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    
    const actionDelay = Math.max(1000, (videoDuration * 1000) / (actions.length || 1));
    
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      console.log(`[performAutomatedInteractions] Performing action ${i + 1}/${actions.length}:`, action.type, action.element);
      
      try {
        if (action.type === 'click') {
          const searchText = action.element.toLowerCase();
          const actionValue = action.value || '';
          const clickCode = `
            (function() {
              const searchTerms = "${searchText}".split(/[\\s,]+/).filter(t => t.length > 0);
              const actionValue = "${actionValue}";
              
              const isDropdownAction = "${searchText}".toLowerCase().includes('dropdown') || "${searchText}".toLowerCase().includes('select') || "${searchText}".toLowerCase().includes('option');
              const isOptionAction = "${searchText}".toLowerCase().includes('option') && !"${searchText}".toLowerCase().includes('dropdown');
              
              if (isDropdownAction) {
                const selects = Array.from(document.querySelectorAll('select'));
                const allSelects = selects.map(select => {
                  const rect = select.getBoundingClientRect();
                  const isInViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                  const hasSize = select.offsetWidth > 0 && select.offsetHeight > 0;
                  const label = select.closest('label')?.textContent?.toLowerCase() || '';
                  const name = (select.name || '').toLowerCase();
                  const id = (select.id || '').toLowerCase();
                  
                  const previousSibling = select.previousElementSibling?.textContent?.toLowerCase() || '';
                  const parentText = select.parentElement?.textContent?.toLowerCase() || '';
                  const ariaLabel = (select.getAttribute('aria-label') || '').toLowerCase();
                  const placeholder = (select.getAttribute('placeholder') || '').toLowerCase();
                  
                  const optionTexts = Array.from(select.options).map(opt => opt.text.toLowerCase()).join(' ');
                  
                  return {
                    element: select,
                    label: label,
                    name: name,
                    id: id,
                    previousSibling: previousSibling,
                    parentText: parentText,
                    ariaLabel: ariaLabel,
                    placeholder: placeholder,
                    optionTexts: optionTexts,
                    visible: hasSize,
                    inViewport: isInViewport
                  };
                }).filter(info => info.visible);
                
                console.log('[Element Search] Searching for dropdown. Search terms:', searchTerms);
                console.log('[Element Search] Found', allSelects.length, 'visible select elements');
                allSelects.forEach((info, idx) => {
                  console.log(\`[Element Search] Select \${idx + 1}:\`, {
                    label: info.label,
                    name: info.name,
                    id: info.id,
                    previousSibling: info.previousSibling.substring(0, 50),
                    ariaLabel: info.ariaLabel,
                    optionTexts: info.optionTexts.substring(0, 100)
                  });
                });
                
                let matches = [];
                
                let optionToFind = actionValue.toLowerCase();
                if (isOptionAction && !optionToFind) {
                  const optionTerms = searchTerms.filter(t => t !== 'option' && t !== 'click');
                  optionToFind = optionTerms.join(' ');
                }
                
                for (const info of allSelects) {
                  let score = 0;
                  for (const term of searchTerms) {
                    if (term === 'dropdown' || term === 'select' || term === 'option') continue;
                    if (info.label.includes(term)) score += 3;
                    if (info.name.includes(term)) score += 2;
                    if (info.id.includes(term)) score += 2;
                    if (info.previousSibling.includes(term)) score += 2;
                    if (info.parentText.includes(term)) score += 1;
                    if (info.ariaLabel.includes(term)) score += 2;
                    if (info.placeholder.includes(term)) score += 2;
                    if (info.optionTexts.includes(term)) score += 1;
                  }
                  
                  if (isOptionAction && optionToFind) {
                    if (info.optionTexts.includes(optionToFind)) {
                      score += 10;
                    }
                    const optionArray = info.optionTexts.split(' ');
                    for (const opt of optionArray) {
                      if (opt.includes(optionToFind) || optionToFind.includes(opt)) {
                        score += 5;
                        break;
                      }
                    }
                  }
                  
                  if (score > 0) {
                    matches.push({ element: info.element, score: score, inViewport: info.inViewport });
                    console.log(\`[Element Search] Match found with score \${score}\`);
                  }
                }
                
                matches.sort((a, b) => {
                  if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
                  return b.score - a.score;
                });
                
                if (matches.length > 0) {
                  const select = matches[0].element;
                  const needsScroll = !matches[0].inViewport;
                  if (needsScroll) {
                    select.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                  
                  let optionSelected = false;
                  let selectedOptionText = '';
                  
                  let optionToFind = actionValue.toLowerCase();
                  
                  if (isOptionAction && !optionToFind) {
                    const optionTerms = searchTerms.filter(t => t !== 'option' && t !== 'click');
                    optionToFind = optionTerms.join(' ');
                  }
                  
                  if (optionToFind) {
                    console.log('[Dropdown Selection] Looking for option:', optionToFind);
                    console.log('[Dropdown Selection] Available options:', Array.from(select.options).map(o => o.text));
                    
                    for (let i = 0; i < select.options.length; i++) {
                      const option = select.options[i];
                      const optionText = option.text.toLowerCase();
                      const optionVal = option.value.toLowerCase();
                      
                      if (optionText === optionToFind || optionVal === optionToFind) {
                        select.selectedIndex = i;
                        selectedOptionText = option.text;
                        optionSelected = true;
                        console.log('[Dropdown Selection] Exact match found:', option.text);
                        break;
                      }
                    }
                    
                    if (!optionSelected) {
                      for (let i = 0; i < select.options.length; i++) {
                        const option = select.options[i];
                        const optionText = option.text.toLowerCase();
                        const optionVal = option.value.toLowerCase();
                        
                        if (optionText.includes(optionToFind) || optionVal.includes(optionToFind) ||
                            optionToFind.includes(optionText) || optionToFind.includes(optionVal)) {
                          select.selectedIndex = i;
                          selectedOptionText = option.text;
                          optionSelected = true;
                          console.log('[Dropdown Selection] Partial match found:', option.text);
                          break;
                        }
                      }
                    }
                  }
                  
                  select.dispatchEvent(new Event('change', { bubbles: true }));
                  
                  return { 
                    success: true, 
                    element: select.tagName,
                    matchedBy: matches[0].inViewport ? 'dropdown (visible)' : 'dropdown (scrolled into view)',
                    wasScrolled: needsScroll,
                    isDropdown: true,
                    optionSelected: optionSelected,
                    selectedOptionText: selectedOptionText || (select.options[select.selectedIndex]?.text || ''),
                    optionSearched: optionToFind
                  };
                }
              }
              
              const clickableElements = Array.from(document.querySelectorAll('button, a, [onclick], [role="button"], input[type="button"], input[type="submit"]'));
              const allElements = clickableElements.map(el => {
                const rect = el.getBoundingClientRect();
                const isInViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                const hasSize = el.offsetWidth > 0 && el.offsetHeight > 0;
                return {
                  element: el,
                  text: (el.textContent || '').trim().toLowerCase(),
                  ariaLabel: (el.getAttribute('aria-label') || '').toLowerCase(),
                  title: (el.getAttribute('title') || '').toLowerCase(),
                  value: (el.value || '').toLowerCase(),
                  visible: hasSize,
                  inViewport: isInViewport,
                  rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right }
                };
              }).filter(info => info.visible);
              
              let matches = [];
              
              for (const info of allElements) {
                let score = 0;
                for (const term of searchTerms) {
                  if (info.text.includes(term)) score += 3;
                  if (info.ariaLabel.includes(term)) score += 2;
                  if (info.title.includes(term)) score += 2;
                  if (info.value.includes(term)) score += 2;
                }
                if (score > 0) {
                  matches.push({ element: info.element, score: score, inViewport: info.inViewport, rect: info.rect });
                }
              }
              
              matches.sort((a, b) => {
                if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
                return b.score - a.score;
              });
              
              if (matches.length > 0) {
                const target = matches[0].element;
                const needsScroll = !matches[0].inViewport;
                if (needsScroll) {
                  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                target.click();
                return { 
                  success: true, 
                  element: target.tagName,
                  matchedBy: matches[0].inViewport ? 'text match (visible)' : 'text match (scrolled into view)',
                  availableElements: allElements.length,
                  wasScrolled: needsScroll
                };
              }
              
              const selects = Array.from(document.querySelectorAll('select'));
              const allSelects = selects.map(select => {
                const rect = select.getBoundingClientRect();
                const isInViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                const hasSize = select.offsetWidth > 0 && select.offsetHeight > 0;
                const label = select.closest('label')?.textContent?.toLowerCase() || '';
                const name = (select.name || '').toLowerCase();
                const id = (select.id || '').toLowerCase();
                
                const previousSibling = select.previousElementSibling?.textContent?.toLowerCase() || '';
                const parentText = select.parentElement?.textContent?.toLowerCase() || '';
                const ariaLabel = (select.getAttribute('aria-label') || '').toLowerCase();
                const placeholder = (select.getAttribute('placeholder') || '').toLowerCase();
                
                const optionTexts = Array.from(select.options).map(opt => opt.text.toLowerCase()).join(' ');
                
                return {
                  element: select,
                  label: label,
                  name: name,
                  id: id,
                  previousSibling: previousSibling,
                  parentText: parentText,
                  ariaLabel: ariaLabel,
                  placeholder: placeholder,
                  optionTexts: optionTexts,
                  visible: hasSize,
                  inViewport: isInViewport
                };
              }).filter(info => info.visible);
              
              console.log('[Element Search] Fallback: Searching for dropdown. Search terms:', searchTerms);
              console.log('[Element Search] Fallback: Found', allSelects.length, 'visible select elements');
              
              let selectMatches = [];
              
              let optionToFindFallback = actionValue.toLowerCase();
              if (isOptionAction && !optionToFindFallback) {
                const optionTerms = searchTerms.filter(t => t !== 'option' && t !== 'click');
                optionToFindFallback = optionTerms.join(' ');
              }
              
              for (const info of allSelects) {
                let score = 0;
                for (const term of searchTerms) {
                  if (term === 'dropdown' || term === 'select' || term === 'option') continue;
                  if (info.label.includes(term)) score += 3;
                  if (info.name.includes(term)) score += 2;
                  if (info.id.includes(term)) score += 2;
                  if (info.previousSibling.includes(term)) score += 2;
                  if (info.parentText.includes(term)) score += 1;
                  if (info.ariaLabel.includes(term)) score += 2;
                  if (info.placeholder.includes(term)) score += 2;
                  if (info.optionTexts.includes(term)) score += 1;
                }
                
                if (isOptionAction && optionToFindFallback) {
                  if (info.optionTexts.includes(optionToFindFallback)) {
                    score += 10;
                  }
                  const optionArray = info.optionTexts.split(' ');
                  for (const opt of optionArray) {
                    if (opt.includes(optionToFindFallback) || optionToFindFallback.includes(opt)) {
                      score += 5;
                      break;
                    }
                  }
                }
                
                if (score > 0) {
                  selectMatches.push({ element: info.element, score: score, inViewport: info.inViewport });
                  console.log(\`[Element Search] Fallback: Match found with score \${score}\`);
                }
              }
              
              selectMatches.sort((a, b) => {
                if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
                return b.score - a.score;
              });
              
              if (selectMatches.length > 0) {
                const select = selectMatches[0].element;
                const needsScroll = !selectMatches[0].inViewport;
                if (needsScroll) {
                  select.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                
                let optionSelected = false;
                let selectedOptionText = '';
                
                let optionToFind = optionToFindFallback || actionValue.toLowerCase();
                
                if (isOptionAction && !optionToFind) {
                  const optionTerms = searchTerms.filter(t => t !== 'option' && t !== 'click');
                  optionToFind = optionTerms.join(' ');
                }
                
                if (optionToFind) {
                  console.log('[Dropdown Selection Fallback] Looking for option:', optionToFind);
                  console.log('[Dropdown Selection Fallback] Available options:', Array.from(select.options).map(o => o.text));
                  
                  for (let i = 0; i < select.options.length; i++) {
                    const option = select.options[i];
                    const optionText = option.text.toLowerCase();
                    const optionVal = option.value.toLowerCase();
                    
                    if (optionText === optionToFind || optionVal === optionToFind) {
                      select.selectedIndex = i;
                      selectedOptionText = option.text;
                      optionSelected = true;
                      console.log('[Dropdown Selection Fallback] Exact match found:', option.text);
                      break;
                    }
                  }
                  
                  if (!optionSelected) {
                    for (let i = 0; i < select.options.length; i++) {
                      const option = select.options[i];
                      const optionText = option.text.toLowerCase();
                      const optionVal = option.value.toLowerCase();
                      
                      if (optionText.includes(optionToFind) || optionVal.includes(optionToFind) ||
                          optionToFind.includes(optionText) || optionToFind.includes(optionVal)) {
                        select.selectedIndex = i;
                        selectedOptionText = option.text;
                        optionSelected = true;
                        console.log('[Dropdown Selection Fallback] Partial match found:', option.text);
                        break;
                      }
                    }
                  }
                }
                
                if (!optionSelected && select.options.length > 0) {
                  select.selectedIndex = 0;
                  selectedOptionText = select.options[0].text;
                }
                
                select.dispatchEvent(new Event('change', { bubbles: true }));
                
                return { 
                  success: true, 
                  element: select.tagName,
                  matchedBy: selectMatches[0].inViewport ? 'dropdown (visible)' : 'dropdown (scrolled into view)',
                  availableElements: allElements.length,
                  wasScrolled: needsScroll,
                  isDropdown: true,
                  optionSelected: optionSelected,
                  selectedOptionText: selectedOptionText,
                  optionSearched: optionToFind
                };
              }
              
              const isInputAction = "${searchText}".toLowerCase().includes('input') || "${searchText}".toLowerCase().includes('text area') || "${searchText}".toLowerCase().includes('textarea') || "${searchText}".toLowerCase().includes('field');
              
              if (isInputAction) {
                const inputs = Array.from(document.querySelectorAll('input, textarea'));
                const allInputs = inputs.map(input => {
                  const rect = input.getBoundingClientRect();
                  const isInViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                  const hasSize = input.offsetWidth > 0 && input.offsetHeight > 0;
                  const placeholder = (input.placeholder || '').toLowerCase();
                  const label = (input.closest('label')?.textContent || '').toLowerCase();
                  const name = (input.name || '').toLowerCase();
                  const id = (input.id || '').toLowerCase();
                  const type = (input.type || '').toLowerCase();
                  const tagName = input.tagName.toLowerCase();
                  
                  return {
                    element: input,
                    placeholder: placeholder,
                    label: label,
                    name: name,
                    id: id,
                    type: type,
                    tagName: tagName,
                    visible: hasSize,
                    inViewport: isInViewport
                  };
                }).filter(info => info.visible);
                
                console.log('[Element Search] Fallback: Searching for input field. Search terms:', searchTerms);
                console.log('[Element Search] Fallback: Found', allInputs.length, 'visible input elements');
                
                let inputMatches = [];
                
                for (const info of allInputs) {
                  let score = 0;
                  for (const term of searchTerms) {
                    if (term === 'input' || term === 'click' || term === 'area') continue;
                    if (info.placeholder.includes(term)) score += 3;
                    if (info.label.includes(term)) score += 3;
                    if (info.name.includes(term)) score += 2;
                    if (info.id.includes(term)) score += 2;
                    if (info.type.includes(term)) score += 1;
                    if (info.tagName.includes(term)) score += 1;
                  }
                  
                  if ("${searchText}".toLowerCase().includes('textarea') && info.tagName === 'textarea') {
                    score += 5;
                  }
                  if ("${searchText}".toLowerCase().includes('text area') && info.tagName === 'textarea') {
                    score += 5;
                  }
                  
                  if (score > 0 || allInputs.length === 1) {
                    inputMatches.push({ element: info.element, score: score, inViewport: info.inViewport });
                  }
                }
                
                inputMatches.sort((a, b) => {
                  if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
                  return b.score - a.score;
                });
                
                if (inputMatches.length > 0) {
                  const input = inputMatches[0].element;
                  const needsScroll = !inputMatches[0].inViewport;
                  if (needsScroll) {
                    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                  input.focus();
                  
                  return { 
                    success: true, 
                    element: input.tagName,
                    matchedBy: inputMatches[0].inViewport ? 'input field (visible)' : 'input field (scrolled into view)',
                    availableElements: allElements.length,
                    wasScrolled: needsScroll,
                    isInput: true
                  };
                }
              }
              
              console.log('[Element Search] No matches found. Returning error.');
              console.log('[Element Search] Available clickable elements:', allElements.length);
              console.log('[Element Search] Available select elements:', allSelects.length);
              
              return { 
                success: false, 
                error: 'Clickable element not found',
                availableElements: allElements.length,
                availableSelects: allSelects.length,
                searchTerms: searchTerms,
                debugInfo: {
                  clickableElements: allElements.map(el => ({
                    text: el.text.substring(0, 50),
                    ariaLabel: el.ariaLabel,
                    title: el.title,
                    value: el.value
                  })),
                  selectElements: allSelects.map(sel => ({
                    label: sel.label.substring(0, 50),
                    name: sel.name,
                    id: sel.id,
                    previousSibling: sel.previousSibling.substring(0, 50),
                    optionTexts: sel.optionTexts.substring(0, 100)
                  }))
                }
              };
            })()
          `;
          
          const result = await chrome.debugger.sendCommand(
            { tabId },
            "Runtime.evaluate",
            { expression: clickCode, returnByValue: true }
          );
          
          if (!result.result?.value?.success) {
            const errorMsg = `Failed to click element: ${action.element}. ${result.result?.value?.error || 'Element not found'}. Available clickable elements: ${result.result?.value?.availableElements || 0}`;
            console.error(`[performAutomatedInteractions] ${errorMsg}`);
            console.error(`[performAutomatedInteractions] Result:`, result.result?.value);
            await chrome.debugger.detach({ tabId });
            throw new Error(errorMsg);
          } else {
            if (result.result?.value?.isDropdown) {
              if (result.result?.value?.optionSelected) {
                console.log(`[performAutomatedInteractions] Successfully selected dropdown option: "${result.result?.value?.selectedOptionText}"`);
              } else {
                console.log(`[performAutomatedInteractions] Dropdown found but no option selected. Searched for: "${result.result?.value?.optionSearched || 'none'}", Selected: "${result.result?.value?.selectedOptionText || 'none'}"`);
              }
            } else if (result.result?.value?.isInput) {
              console.log(`[performAutomatedInteractions] Successfully focused input field. Matched by: ${result.result?.value?.matchedBy}`);
            } else {
              console.log(`[performAutomatedInteractions] Successfully clicked element. Matched by: ${result.result?.value?.matchedBy}`);
            }
            if (result.result?.value?.wasScrolled) {
              console.log(`[performAutomatedInteractions] Element was scrolled into view before interaction`);
              await new Promise(resolve => setTimeout(resolve, 1500));
            } else {
              await new Promise(resolve => setTimeout(resolve, result.result?.value?.isInput ? 500 : 2000));
            }
          }
          
        } else if (action.type === 'type') {
          const searchText = action.element.toLowerCase();
          const typeCode = `
            (function() {
              const inputs = Array.from(document.querySelectorAll('input, textarea'));
              const allInputs = inputs.map(input => {
                const rect = input.getBoundingClientRect();
                const isInViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                const hasSize = input.offsetWidth > 0 && input.offsetHeight > 0;
                return {
                  element: input,
                  placeholder: (input.placeholder || '').toLowerCase(),
                  label: (input.closest('label')?.textContent || '').toLowerCase(),
                  name: (input.name || '').toLowerCase(),
                  id: (input.id || '').toLowerCase(),
                  type: (input.type || '').toLowerCase(),
                  visible: hasSize,
                  inViewport: isInViewport,
                  rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right }
                };
              }).filter(info => info.visible);
              
              let matches = [];
              
              const searchTerms = "${searchText}".split(/[\\s,]+/).filter(t => t.length > 0);
              
              for (const info of allInputs) {
                let score = 0;
                for (const term of searchTerms) {
                  if (info.placeholder.includes(term)) score += 3;
                  if (info.label.includes(term)) score += 3;
                  if (info.name.includes(term)) score += 2;
                  if (info.id.includes(term)) score += 2;
                  if (info.type.includes(term)) score += 1;
                }
                if (score > 0) {
                  matches.push({ element: info.element, score: score });
                }
              }
              
              if (matches.length === 0 && allInputs.length > 0) {
                const textInputs = allInputs.filter(info => info.type === 'text' || info.type === '' || info.element.tagName === 'TEXTAREA');
                if (textInputs.length > 0) {
                  matches = textInputs.map(info => ({ element: info.element, score: 0.5, inViewport: info.inViewport, rect: info.rect }));
                } else {
                  matches = allInputs.map(info => ({ element: info.element, score: 0.5, inViewport: info.inViewport, rect: info.rect }));
                }
              }
              
              matches.sort((a, b) => {
                if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
                return b.score - a.score;
              });
              
              if (matches.length > 0) {
                const input = matches[0].element;
                const needsScroll = !matches[0].inViewport;
                if (needsScroll) {
                  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                input.focus();
                input.value = "${action.value}";
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return { 
                  success: true, 
                  element: input.tagName,
                  matchedBy: matches[0].score > 1 ? (matches[0].inViewport ? 'text match (visible)' : 'text match (scrolled into view)') : (matches[0].inViewport ? 'first available (visible)' : 'first available (scrolled into view)'),
                  availableInputs: allInputs.length,
                  wasScrolled: needsScroll
                };
              }
              return { 
                success: false, 
                error: 'No input fields found on page',
                availableInputs: 0
              };
            })()
          `;
          
          const result = await chrome.debugger.sendCommand(
            { tabId },
            "Runtime.evaluate",
            { expression: typeCode, returnByValue: true }
          );
          
          if (!result.result?.value?.success) {
            const errorMsg = `Failed to type into element: ${action.element}. ${result.result?.value?.error || 'Input field not found'}. Available inputs: ${result.result?.value?.availableInputs || 0}`;
            console.error(`[performAutomatedInteractions] ${errorMsg}`);
            console.error(`[performAutomatedInteractions] Result:`, result.result?.value);
            await chrome.debugger.detach({ tabId });
            throw new Error(errorMsg);
          } else {
            console.log(`[performAutomatedInteractions] Successfully typed into element. Matched by: ${result.result?.value?.matchedBy}`);
            if (result.result?.value?.wasScrolled) {
              console.log(`[performAutomatedInteractions] Input was scrolled into view before typing`);
              await new Promise(resolve => setTimeout(resolve, 1500));
            } else {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
          
        } else if (action.type === 'navigate') {
          const searchText = action.element.toLowerCase();
          const navCode = `
            (function() {
              const searchTerms = "${searchText}".split(/[\\s,]+/).filter(t => t.length > 0);
              const navElements = Array.from(document.querySelectorAll('a, button, [role="link"]'));
              const allElements = navElements.map(el => {
                const rect = el.getBoundingClientRect();
                const isInViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                const hasSize = el.offsetWidth > 0 && el.offsetHeight > 0;
                return {
                  element: el,
                  text: (el.textContent || '').trim().toLowerCase(),
                  ariaLabel: (el.getAttribute('aria-label') || '').toLowerCase(),
                  href: (el.href || '').toLowerCase(),
                  visible: hasSize,
                  inViewport: isInViewport,
                  rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right }
                };
              }).filter(info => info.visible);
              
              let matches = [];
              
              for (const info of allElements) {
                let score = 0;
                for (const term of searchTerms) {
                  if (info.text.includes(term)) score += 3;
                  if (info.ariaLabel.includes(term)) score += 2;
                  if (info.href.includes(term)) score += 1;
                }
                if (score > 0) {
                  matches.push({ element: info.element, score: score, inViewport: info.inViewport, rect: info.rect });
                }
              }
              
              matches.sort((a, b) => {
                if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
                return b.score - a.score;
              });
              
              if (matches.length > 0) {
                const target = matches[0].element;
                const needsScroll = !matches[0].inViewport;
                if (needsScroll) {
                  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                target.click();
                return { 
                  success: true, 
                  element: target.tagName,
                  matchedBy: matches[0].inViewport ? 'text match (visible)' : 'text match (scrolled into view)',
                  availableElements: allElements.length,
                  wasScrolled: needsScroll
                };
              }
              return { 
                success: false, 
                error: 'Navigation element not found',
                availableElements: allElements.length
              };
            })()
          `;
          
          const result = await chrome.debugger.sendCommand(
            { tabId },
            "Runtime.evaluate",
            { expression: navCode, returnByValue: true }
          );
          
          if (!result.result?.value?.success) {
            const errorMsg = `Failed to navigate using element: ${action.element}. ${result.result?.value?.error || 'Navigation element not found'}. Available navigation elements: ${result.result?.value?.availableElements || 0}`;
            console.error(`[performAutomatedInteractions] ${errorMsg}`);
            console.error(`[performAutomatedInteractions] Result:`, result.result?.value);
            await chrome.debugger.detach({ tabId });
            throw new Error(errorMsg);
          } else {
            console.log(`[performAutomatedInteractions] Successfully navigated using element. Matched by: ${result.result?.value?.matchedBy}`);
            if (result.result?.value?.wasScrolled) {
              console.log(`[performAutomatedInteractions] Navigation element was scrolled into view before clicking`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }
          
        } else if (action.type === 'select') {
          const searchText = action.element.toLowerCase();
          const selectValue = action.value || '';
          const selectCode = `
            (function() {
              const searchTerms = "${searchText}".split(/[\\s,]+/).filter(t => t.length > 0);
              const selects = Array.from(document.querySelectorAll('select'));
              const allSelects = selects.map(select => {
                const rect = select.getBoundingClientRect();
                const isInViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                const hasSize = select.offsetWidth > 0 && select.offsetHeight > 0;
                const label = select.closest('label')?.textContent?.toLowerCase() || '';
                const name = (select.name || '').toLowerCase();
                const id = (select.id || '').toLowerCase();
                
                const previousSibling = select.previousElementSibling?.textContent?.toLowerCase() || '';
                const parentText = select.parentElement?.textContent?.toLowerCase() || '';
                const ariaLabel = (select.getAttribute('aria-label') || '').toLowerCase();
                const placeholder = (select.getAttribute('placeholder') || '').toLowerCase();
                
                const optionTexts = Array.from(select.options).map(opt => opt.text.toLowerCase()).join(' ');
                
                return {
                  element: select,
                  label: label,
                  name: name,
                  id: id,
                  previousSibling: previousSibling,
                  parentText: parentText,
                  ariaLabel: ariaLabel,
                  placeholder: placeholder,
                  optionTexts: optionTexts,
                  visible: hasSize,
                  inViewport: isInViewport
                };
              }).filter(info => info.visible);
              
              console.log('[Select Handler] Searching for dropdown. Search terms:', searchTerms);
              console.log('[Select Handler] Found', allSelects.length, 'visible select elements');
              
              let matches = [];
              
              for (const info of allSelects) {
                let score = 0;
                for (const term of searchTerms) {
                  if (term === 'dropdown' || term === 'select' || term === 'option') continue;
                  if (info.label.includes(term)) score += 3;
                  if (info.name.includes(term)) score += 2;
                  if (info.id.includes(term)) score += 2;
                  if (info.previousSibling.includes(term)) score += 2;
                  if (info.parentText.includes(term)) score += 1;
                  if (info.ariaLabel.includes(term)) score += 2;
                  if (info.placeholder.includes(term)) score += 2;
                  if (info.optionTexts.includes(term)) score += 1;
                }
                if (score > 0) {
                  matches.push({ element: info.element, score: score, inViewport: info.inViewport });
                  console.log(\`[Select Handler] Match found with score \${score}\`);
                }
              }
              
              matches.sort((a, b) => {
                if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
                return b.score - a.score;
              });
              
              if (matches.length > 0) {
                const select = matches[0].element;
                const needsScroll = !matches[0].inViewport;
                if (needsScroll) {
                  select.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                
                const optionValue = "${selectValue}".toLowerCase();
                let optionFound = false;
                let selectedOptionText = '';
                
                console.log('[Select Handler] Looking for option:', optionValue);
                console.log('[Select Handler] Available options:', Array.from(select.options).map(o => o.text));
                
                if (optionValue) {
                  for (let i = 0; i < select.options.length; i++) {
                    const option = select.options[i];
                    const optionText = option.text.toLowerCase();
                    const optionVal = option.value.toLowerCase();
                    
                    if (optionText === optionValue || optionVal === optionValue) {
                      select.selectedIndex = i;
                      selectedOptionText = option.text;
                      optionFound = true;
                      console.log('[Select Handler] Exact match found:', option.text);
                      break;
                    }
                  }

                  if (!optionFound) {
                    for (let i = 0; i < select.options.length; i++) {
                      const option = select.options[i];
                      const optionText = option.text.toLowerCase();
                      const optionVal = option.value.toLowerCase();
                      
                      if (optionText.includes(optionValue) || optionVal.includes(optionValue) ||
                          optionValue.includes(optionText) || optionValue.includes(optionVal)) {
                        select.selectedIndex = i;
                        selectedOptionText = option.text;
                        optionFound = true;
                        console.log('[Select Handler] Partial match found:', option.text);
                        break;
                      }
                    }
                  }
                }
                
                // If still no match found, select first option as fallback
                if (!optionFound && select.options.length > 0) {
                  select.selectedIndex = 0;
                  selectedOptionText = select.options[0].text;
                  console.log('[Select Handler] No match found, selected first option:', selectedOptionText);
                }
                
                select.dispatchEvent(new Event('change', { bubbles: true }));
                
                return { 
                  success: true, 
                  element: select.tagName,
                  matchedBy: matches[0].inViewport ? 'text match (visible)' : 'text match (scrolled into view)',
                  optionSelected: optionFound,
                  selectedOptionText: selectedOptionText || (select.options[select.selectedIndex]?.text || ''),
                  wasScrolled: needsScroll
                };
              }
              
              console.log('[Select Handler] No matches found. Available selects:', allSelects.length);
              allSelects.forEach((info, idx) => {
                console.log(\`[Select Handler] Select \${idx + 1}:\`, {
                  label: info.label.substring(0, 50),
                  name: info.name,
                  id: info.id,
                  previousSibling: info.previousSibling.substring(0, 50),
                  ariaLabel: info.ariaLabel,
                  optionTexts: info.optionTexts.substring(0, 100)
                });
              });
              
              return { 
                success: false, 
                error: 'Select dropdown not found',
                availableSelects: allSelects.length
              };
            })()
          `;
          
          const result = await chrome.debugger.sendCommand(
            { tabId },
            "Runtime.evaluate",
            { expression: selectCode, returnByValue: true }
          );
          
          if (!result.result?.value?.success) {
            const errorMsg = `Failed to select option in dropdown: ${action.element}. ${result.result?.value?.error || 'Dropdown not found'}`;
            console.error(`[performAutomatedInteractions] ${errorMsg}`);
            await chrome.debugger.detach({ tabId });
            throw new Error(errorMsg);
          } else {
            console.log(`[performAutomatedInteractions] Successfully selected option "${action.value}" in dropdown`);
            if (result.result?.value?.wasScrolled) {
              await new Promise(resolve => setTimeout(resolve, 1500));
            } else {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
          
        } else if (action.type === 'checkbox') {
          const searchText = action.element.toLowerCase();
          const shouldCheck = action.value === 'check';
          const checkboxCode = `
            (function() {
              const searchTerms = "${searchText}".split(/[\\s,]+/).filter(t => t.length > 0);
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              const allCheckboxes = checkboxes.map(cb => {
                const rect = cb.getBoundingClientRect();
                const isInViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                const hasSize = cb.offsetWidth > 0 && cb.offsetHeight > 0;
                const label = cb.closest('label')?.textContent?.toLowerCase() || cb.nextElementSibling?.textContent?.toLowerCase() || '';
                const name = (cb.name || '').toLowerCase();
                const id = (cb.id || '').toLowerCase();
                return {
                  element: cb,
                  label: label,
                  name: name,
                  id: id,
                  visible: hasSize,
                  inViewport: isInViewport
                };
              }).filter(info => info.visible);
              
              let matches = [];
              
              for (const info of allCheckboxes) {
                let score = 0;
                for (const term of searchTerms) {
                  if (info.label.includes(term)) score += 3;
                  if (info.name.includes(term)) score += 2;
                  if (info.id.includes(term)) score += 2;
                }
                if (score > 0) {
                  matches.push({ element: info.element, score: score, inViewport: info.inViewport });
                }
              }
              
              matches.sort((a, b) => {
                if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
                return b.score - a.score;
              });
              
              if (matches.length > 0) {
                const checkbox = matches[0].element;
                const needsScroll = !matches[0].inViewport;
                if (needsScroll) {
                  checkbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                
                if (checkbox.checked !== ${shouldCheck}) {
                  checkbox.click();
                }
                
                return { 
                  success: true, 
                  element: checkbox.tagName,
                  matchedBy: matches[0].inViewport ? 'text match (visible)' : 'text match (scrolled into view)',
                  wasScrolled: needsScroll
                };
              }
              return { 
                success: false, 
                error: 'Checkbox not found',
                availableCheckboxes: allCheckboxes.length
              };
            })()
          `;
          
          const result = await chrome.debugger.sendCommand(
            { tabId },
            "Runtime.evaluate",
            { expression: checkboxCode, returnByValue: true }
          );
          
          if (!result.result?.value?.success) {
            const errorMsg = `Failed to ${shouldCheck ? 'check' : 'uncheck'} checkbox: ${action.element}. ${result.result?.value?.error || 'Checkbox not found'}`;
            console.error(`[performAutomatedInteractions] ${errorMsg}`);
            await chrome.debugger.detach({ tabId });
            throw new Error(errorMsg);
          } else {
            console.log(`[performAutomatedInteractions] Successfully ${shouldCheck ? 'checked' : 'unchecked'} checkbox`);
            if (result.result?.value?.wasScrolled) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
          
        } else if (action.type === 'radio') {
          const searchText = action.element.toLowerCase();
          const radioValue = action.value || '';
          const radioCode = `
            (function() {
              const searchTerms = "${searchText}".split(/[\\s,]+/).filter(t => t.length > 0);
              const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
              const allRadios = radios.map(radio => {
                const rect = radio.getBoundingClientRect();
                const isInViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                const hasSize = radio.offsetWidth > 0 && radio.offsetHeight > 0;
                const label = radio.closest('label')?.textContent?.toLowerCase() || radio.nextElementSibling?.textContent?.toLowerCase() || '';
                const name = (radio.name || '').toLowerCase();
                const id = (radio.id || '').toLowerCase();
                const value = (radio.value || '').toLowerCase();
                return {
                  element: radio,
                  label: label,
                  name: name,
                  id: id,
                  value: value,
                  visible: hasSize,
                  inViewport: isInViewport
                };
              }).filter(info => info.visible);
              
              let matches = [];
              const optionValue = "${radioValue}".toLowerCase();
              
              for (const info of allRadios) {
                let score = 0;
                for (const term of searchTerms) {
                  if (info.label.includes(term)) score += 3;
                  if (info.name.includes(term)) score += 2;
                  if (info.id.includes(term)) score += 2;
                }
                if (optionValue && (info.label.includes(optionValue) || info.value === optionValue)) {
                  score += 5;
                }
                if (score > 0) {
                  matches.push({ element: info.element, score: score, inViewport: info.inViewport });
                }
              }
              
              matches.sort((a, b) => {
                if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
                return b.score - a.score;
              });
              
              if (matches.length > 0) {
                const radio = matches[0].element;
                const needsScroll = !matches[0].inViewport;
                if (needsScroll) {
                  radio.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                
                radio.click();
                
                return { 
                  success: true, 
                  element: radio.tagName,
                  matchedBy: matches[0].inViewport ? 'text match (visible)' : 'text match (scrolled into view)',
                  wasScrolled: needsScroll
                };
              }
              return { 
                success: false, 
                error: 'Radio button not found',
                availableRadios: allRadios.length
              };
            })()
          `;
          
          const result = await chrome.debugger.sendCommand(
            { tabId },
            "Runtime.evaluate",
            { expression: radioCode, returnByValue: true }
          );
          
          if (!result.result?.value?.success) {
            const errorMsg = `Failed to select radio button: ${action.element}. ${result.result?.value?.error || 'Radio button not found'}`;
            console.error(`[performAutomatedInteractions] ${errorMsg}`);
            await chrome.debugger.detach({ tabId });
            throw new Error(errorMsg);
          } else {
            console.log(`[performAutomatedInteractions] Successfully selected radio button`);
            if (result.result?.value?.wasScrolled) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
          
        } else if (action.type === 'scroll') {
          const scrollCode = `
            (function() {
              window.scrollBy(0, window.innerHeight * 0.8);
              return { success: true };
            })()
          `;
          
          await chrome.debugger.sendCommand(
            { tabId },
            "Runtime.evaluate",
            { expression: scrollCode, returnByValue: true }
          );
          
          await new Promise(resolve => setTimeout(resolve, 1000));
          console.log(`[performAutomatedInteractions] Scrolled page`);
          
        } else {
          console.warn(`[performAutomatedInteractions] Unknown action type: ${action.type}, skipping`);
        }
        
        await new Promise(resolve => setTimeout(resolve, actionDelay));
      } catch (error) {
        console.error(`[performAutomatedInteractions] Error performing action ${i + 1}:`, error);
        console.error(`[performAutomatedInteractions] Action details:`, action);
        try {
          await chrome.debugger.detach({ tabId });
        } catch (e) {
          console.warn('[performAutomatedInteractions] Error detaching debugger:', e);
        }
        throw error;
      }
    }
    
    await chrome.debugger.detach({ tabId });
    console.log('[performAutomatedInteractions] All interactions completed');
  } catch (error) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {}
    console.error('[performAutomatedInteractions] Error:', error);
    throw error;
  }
}

async function performAutomatedInteractionsWithRecording(tabId, actions, videoDuration) {
  const recordedFrames = [];
  let recordingActive = false;
  let frameCaptureInterval = null;
  
  const startRecording = async () => {
    try {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.capture({
          audio: false,
          video: true
        }, (streamId) => {
          if (chrome.runtime.lastError) {
            console.warn('[performAutomatedInteractionsWithRecording] tabCapture failed:', chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!streamId) {
            reject(new Error('Failed to get stream ID from tabCapture'));
          } else {
            resolve(streamId);
          }
        });
      });
      
      console.log('[performAutomatedInteractionsWithRecording] Started recording, stream ID:', streamId);
      recordingActive = true;
      
      const frameInterval = Math.max(0.3, videoDuration / 30);
      let currentTime = 0;
      const maxFrames = 30;
      
      const captureFrame = async () => {
        if (!recordingActive || recordedFrames.length >= maxFrames) {
          return;
        }
        
        try {
          const screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
          recordedFrames.push({
            time: currentTime,
            image: screenshot,
            timestamp: currentTime
          });
          currentTime += frameInterval;
          
          if (currentTime < videoDuration && recordedFrames.length < maxFrames) {
            frameCaptureInterval = setTimeout(captureFrame, frameInterval * 1000);
          }
        } catch (error) {
          console.warn('[performAutomatedInteractionsWithRecording] Error capturing frame:', error);
        }
      };
      
      setTimeout(captureFrame, 500);
    } catch (error) {
      console.warn('[performAutomatedInteractionsWithRecording] Failed to start video recording, will use screenshots:', error);
      recordingActive = false;
    }
  };
  
  const stopRecording = () => {
    recordingActive = false;
    if (frameCaptureInterval) {
      clearTimeout(frameCaptureInterval);
      frameCaptureInterval = null;
    }
    console.log('[performAutomatedInteractionsWithRecording] Stopped recording, captured', recordedFrames.length, 'frames');
  };
  
  try {
    await startRecording();
    await performAutomatedInteractions(tabId, actions, videoDuration);
    await new Promise(resolve => setTimeout(resolve, 1000));
    stopRecording();
    
    if (recordedFrames.length === 0) {
      console.warn('[performAutomatedInteractionsWithRecording] No frames recorded, capturing final screenshot');
      const snapshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      recordedFrames.push({
        time: 0,
        image: snapshot,
        timestamp: 0
      });
    }
    
    return recordedFrames;
  } catch (error) {
    stopRecording();
    throw error;
  }
}

async function recordVideoFromTab(tabId, duration) {
  try {
    console.log('[recordVideoFromTab] Starting video recording for', duration, 'seconds');
    
    await chrome.tabs.update(tabId, { active: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.capture({
        audio: false,
        video: true
      }, (streamId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!streamId) {
          reject(new Error('Failed to get stream ID from tabCapture'));
        } else {
          resolve(streamId);
        }
      });
    });
    
    console.log('[recordVideoFromTab] Got stream ID:', streamId);
    
    return new Promise((resolve, reject) => {
      const frames = [];
      const frameInterval = Math.max(0.5, duration / 25);
      let currentTime = 0;
      let captureCount = 0;
      const maxFrames = 25;
      
      const captureFrame = async () => {
        try {
          const screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
          frames.push({
            time: currentTime,
            image: screenshot,
            timestamp: currentTime
          });
          captureCount++;
          currentTime += frameInterval;
          
          if (currentTime >= duration || captureCount >= maxFrames) {
            console.log('[recordVideoFromTab] Recording complete:', frames.length, 'frames captured');
            resolve(frames);
          } else {
            setTimeout(captureFrame, frameInterval * 1000);
          }
        } catch (error) {
          console.error('[recordVideoFromTab] Error capturing frame:', error);
          if (frames.length > 0) {
            console.log('[recordVideoFromTab] Returning', frames.length, 'captured frames despite error');
            resolve(frames);
          } else {
            reject(error);
          }
        }
      };
      
      setTimeout(captureFrame, 1000);
      
      setTimeout(() => {
        if (frames.length === 0) {
          reject(new Error('No frames captured during recording'));
        }
      }, duration * 1000 + 5000);
    });
  } catch (error) {
    console.error('[recordVideoFromTab] Error:', error);
    throw error;
  }
}

async function compareVideos(recordedFrames, originalFrames) {
  try {
    console.log('[compareVideos] Comparing videos - recorded:', recordedFrames.length, 'original:', originalFrames.length);
    updateStatus('Comparing recorded video with original...');
    
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for video comparison response (180s)'));
      }, 180000);
      
      chrome.runtime.sendMessage({
        action: 'analyzeVideoSimilarity',
        recordedVideoFrames: recordedFrames,
        originalVideoFrames: originalFrames,
        apiKey: GEMINI_API_KEY
      }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
    
    if (response.error) {
      throw new Error(response.error);
    }
    
    return {
      similarity: response.similarity || 0.5,
      feedback: response.feedback || [],
      summary: response.summary || 'Video comparison completed'
    };
  } catch (error) {
    console.error('[compareVideos] Error:', error);
    throw error;
  }
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

async function saveCodeForDownload(code) {
  await chrome.storage.local.set({ downloadCode: code });
}

async function getPreviousCode() {
  const { previousCode } = await chrome.storage.local.get(['previousCode']);
  return previousCode;
}

async function downloadCodeAsZip() {
  try {
    console.log('[downloadCodeAsZip] Starting download...');
    console.log('[downloadCodeAsZip] JSZip available?', typeof JSZip !== 'undefined');
    
    if (typeof JSZip === 'undefined') {
      console.warn('[downloadCodeAsZip] JSZip not immediately available, waiting...');
      await new Promise(resolve => setTimeout(resolve, 500));
      
      if (typeof JSZip === 'undefined') {
        throw new Error('JSZip library not loaded. Please reload the extension and try again.');
      }
    }
    
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let code = null;
    
    if (activeTab && activeTab.id) {
      const storage = await chrome.storage.local.get([`website_${activeTab.id}`]);
      code = storage[`website_${activeTab.id}`];
    }
    
    if (!code) {
      const storage = await chrome.storage.local.get(['downloadCode']);
      code = storage.downloadCode;
    }
    
    if (!code) {
      throw new Error('No code available to download. Please generate a website first.');
    }
    
    console.log('[downloadCodeAsZip] Generating ZIP file...');
    
    const zip = new JSZip();
    const nonce = btoa(Math.random().toString(36)).substring(0, 16);
    
    if (code.pages && Array.isArray(code.pages)) {
      console.log('[downloadCodeAsZip] Multi-page format detected, adding', code.pages.length, 'pages');
      
      code.pages.forEach(page => {
        const pageName = page.name || 'index.html';
        let htmlContent = page.html || '';
        htmlContent = injectCSSAndJS(htmlContent, code.css, code.js, nonce);
        zip.file(pageName, htmlContent);
        console.log(`[downloadCodeAsZip] Added page: ${pageName}`);
      });
    } else {
      console.log('[downloadCodeAsZip] Single-page format detected');
      
      let htmlContent = code.html || '<!DOCTYPE html><html><head><title>Generated Website</title></head><body></body></html>';
      htmlContent = injectCSSAndJS(htmlContent, code.css, code.js, nonce);
      zip.file('index.html', htmlContent);
      console.log('[downloadCodeAsZip] Added index.html');
    }
    
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `codify-website-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log('[downloadCodeAsZip] ZIP file downloaded successfully');
  } catch (error) {
    console.error('[downloadCodeAsZip] Error:', error);
    alert(`Error downloading code: ${error.message}`);
  }
}

function updateStatus(text) {
  document.getElementById('statusText').textContent = text;
}

function updateProgress(percent, text) {
  document.getElementById('progressFill').style.width = `${percent}%`;
  document.getElementById('progressText').textContent = text;
}
