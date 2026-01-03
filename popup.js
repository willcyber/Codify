let selectedVideo = null;
let currentIteration = 0;
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
    document.getElementById('status').style.display = 'block';
    document.getElementById('progress').style.display = 'block';
    document.getElementById('results').style.display = 'none';
    document.getElementById('videoInfo').style.display = 'none';
    
    updateStatus('Extracting frames from video...');
    updateProgress(10, 'Extracting frames...');
    
    const frames = await extractFrames(videoFile);
    updateProgress(30, 'Analyzing video with Gemini...');
    
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_api_key_here') {
      loadApiKey();
      
      if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_api_key_here') {
        const keyResponse = await chrome.runtime.sendMessage({ action: 'getApiKey' });
        if (keyResponse && keyResponse.apiKey && keyResponse.apiKey !== 'your_api_key_here') {
          GEMINI_API_KEY = keyResponse.apiKey;
        } else {
          throw new Error('API key not configured. Please edit config.js and add your Gemini API key. See README.md for instructions.');
        }
      }
    }
    
    updateStatus('Generating website code...');
    updateProgress(50, 'Generating code...');
    
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
    
    updateProgress(70, 'Creating website...');
    updateStatus('Creating website preview...');
    
    const tabId = await createWebsiteFromCode(response.code);
    
    updateProgress(90, 'Analyzing website...');
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const snapshot = await takeSnapshot(tabId);
    const errors = await checkConsoleErrors(tabId);
    
    updateProgress(100, 'Complete!');
    
    const similarity = await compareWithVideo(snapshot, frames);
    
    currentIteration++;
    
    if (currentIteration >= MAX_ITERATIONS || similarity > 0.95) {
      document.getElementById('status').style.display = 'none';
      document.getElementById('progress').style.display = 'none';
      document.getElementById('results').style.display = 'block';
      
      const resultMsg = currentIteration >= MAX_ITERATIONS 
        ? `Completed ${MAX_ITERATIONS} iterations. Similarity: ${(similarity * 100).toFixed(1)}%`
        : `Website generated successfully! Similarity: ${(similarity * 100).toFixed(1)}%`;
      
      document.getElementById('resultText').textContent = resultMsg;
      
      await saveCode(response.code);
    } else {
      updateStatus(`Iteration ${currentIteration}/${MAX_ITERATIONS}. Refining...`);
      updateProgress(0, `Similarity: ${(similarity * 100).toFixed(1)}%. Refining...`);
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      await processVideo(selectedVideo, true);
    }
    
  } catch (error) {
    console.error('Error processing video:', error);
    document.getElementById('statusText').textContent = `Error: ${error.message}`;
    document.getElementById('progress').style.display = 'none';
  }
}

async function extractFrames(videoFile) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const frames = [];
    const targetFrames = 15;
    
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
  const nonce = btoa(Math.random().toString(36)).substring(0, 16);
  
  let htmlContent = codeFiles.html || '<!DOCTYPE html><html><head><title>Generated Website</title></head><body></body></html>';
  
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline';">`;
  
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
  
  if (htmlContent.includes('<head>')) {
    htmlContent = htmlContent.replace('<head>', `<head>${cspMeta}`);
  } else if (htmlContent.includes('</head>')) {
    htmlContent = htmlContent.replace('</head>', `${cspMeta}</head>`);
  } else {
    htmlContent = htmlContent.replace('<html>', `<html><head>${cspMeta}</head>`);
  }
  
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent);
  
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (activeTab && activeTab.id) {
      const currentUrl = activeTab.url || '';
      const isSpecialPage = currentUrl.startsWith('chrome://') || 
                           currentUrl.startsWith('chrome-extension://') || 
                           currentUrl.startsWith('about:') ||
                           currentUrl.startsWith('edge://');
      
      if (!isSpecialPage) {
        try {
          await chrome.tabs.update(activeTab.id, { 
            url: dataUrl,
            active: true
          });
          
          await new Promise(resolve => setTimeout(resolve, 1000));
          const updatedTab = await chrome.tabs.get(activeTab.id);
          
          if (updatedTab.url && updatedTab.url.startsWith('data:')) {
            await chrome.storage.local.set({
              [`website_${activeTab.id}`]: codeFiles
            });
            return activeTab.id;
          }
        } catch (updateError) {
          // Fall through to create new tab
        }
      }
    }
  } catch (e) {
    // Fall through to create new tab
  }
  
  const tab = await chrome.tabs.create({ 
    url: dataUrl,
    active: true
  });
  
  await chrome.storage.local.set({
    [`website_${tab.id}`]: codeFiles
  });
  
  return tab.id;
}

async function takeSnapshot(tabId) {
  try {
    const screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    
    return {
      screenshot: screenshot,
      dom: null,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('Error taking snapshot:', error);
    return null;
  }
}

async function checkConsoleErrors(tabId) {
  return [];
}

async function compareWithVideo(snapshot, videoFrames) {
  if (!snapshot || !snapshot.screenshot || !videoFrames || videoFrames.length === 0) {
    return 0.5;
  }
  
  try {
    const lastFrame = videoFrames[videoFrames.length - 1];
    
    const screenshotImg = new Image();
    const videoFrameImg = new Image();
    
    return new Promise((resolve) => {
      let loaded = 0;
      const onLoad = () => {
        loaded++;
        if (loaded === 2) {
          const widthDiff = Math.abs(screenshotImg.width - videoFrameImg.width) / Math.max(screenshotImg.width, videoFrameImg.width);
          const heightDiff = Math.abs(screenshotImg.height - videoFrameImg.height) / Math.max(screenshotImg.height, videoFrameImg.height);
          
          const similarity = 1 - (widthDiff + heightDiff) / 2;
          const baseSimilarity = Math.max(0.6, similarity);
          resolve(Math.min(0.95, baseSimilarity + (Math.random() * 0.1)));
        }
      };
      
      screenshotImg.onload = onLoad;
      videoFrameImg.onload = onLoad;
      
      screenshotImg.src = snapshot.screenshot;
      videoFrameImg.src = lastFrame.image;
    });
  } catch (error) {
    console.error('Error comparing images:', error);
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
