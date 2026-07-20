let GEMINI_API_KEY = null;
try {
  importScripts('config.js');
  if (typeof GEMINI_API_KEY_CONFIG !== 'undefined') {
    GEMINI_API_KEY = GEMINI_API_KEY_CONFIG;
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_api_key_here' || GEMINI_API_KEY.trim().length === 0) {
      console.warn('API key not configured. Please edit config.js and add your Gemini API key.');
      GEMINI_API_KEY = null;
    } else {
      console.log('API key loaded successfully from config.js');
    }
  } else {
    console.error('GEMINI_API_KEY_CONFIG is undefined. Check that config.js defines this variable.');
  }
} catch (e) {
  console.error('Failed to load API key from config.js:', e);
  console.error('Make sure config.js exists and is in the extension root directory.');
}

async function extractActionsFromVideo(frames, apiKey, code) {
  try {
    console.log('[extractActionsFromVideo] Starting action extraction from', frames.length, 'frames');
    
    const prompt = `You are analyzing a website demo.

You are given:
- A sequence of video frames showing the user interacting with the website
- The EXACT website code (HTML/CSS/JS) that was generated to reproduce this site:

=== GENERATED WEBSITE CODE START ===
${code || '(code not available)'}
=== GENERATED WEBSITE CODE END ===

Use BOTH the video and the code together:
- The video shows what the user actually does
- The code tells you the precise element structure, IDs, names, and dropdown <option> values

CRITICAL FOR DROPDOWNS / SELECT MENUS:
- When the user selects an option from a dropdown, you MUST set the action.value to EXACTLY match one of the <option> texts or values in the generated HTML.
- If the video text is slightly cropped or unclear, use the code to disambiguate:
  - Look at the <select> element and its <option> children in the HTML
  - Choose the option whose text/value best matches what you see in the video
  - Use the exact option text (preferred) or the exact option value string from the HTML
- Do NOT invent arbitrary strings that are not present in the <option> list.
- The goal is that action.value can be matched reliably to a real <option> in the generated code.

Now, analyze these video frames from a website demonstration video. Extract ALL user interactions in chronological order, including every type of interaction.

TASK: Identify EVERY interaction the user performs:
1. CLICKS: Buttons, links, or any clickable elements - identify by EXACT visible text
2. TYPING: Text input into any input field - identify by placeholder/label and provide exact text typed
3. DROPDOWN/SELECT: Selecting an option from a dropdown/select menu - identify the dropdown and the selected option text
4. CHECKBOX: Checking or unchecking checkboxes - identify by label text
5. RADIO: Selecting radio buttons - identify by label text
6. NAVIGATION: Page navigation - identify by link/button text
7. SCROLLING: Any scrolling actions (if significant)
8. OTHER: Any other interactions (sliders, date pickers, etc.)

CRITICAL: For element identification, use the EXACT visible text you see in the video, and cross-check with the provided code when helpful:
- For buttons: Exact button text (e.g., "Submit", "Login", "Go")
- For inputs: Placeholder or label text (e.g., "Enter email", "Password", "Search")
- For dropdowns: Label text or visible selected value (e.g., "Country", "Language", "Select option")
- For checkboxes/radios: Label text next to the element
- For links: Exact link text (e.g., "Home", "About", "Contact")
- Be specific and descriptive

For each action, provide:
- type: "click" | "type" | "select" | "checkbox" | "radio" | "navigate" | "scroll" | "other"
- element: EXACT visible text or clear description of the element
- value: 
  * For typing: the exact text typed
  * For select/dropdown: the option text that was selected
  * For checkbox: "check" or "uncheck"
  * For radio: the option text selected
  * For other types: relevant value or null
- timing: Approximate sequence number (1, 2, 3, etc.)
- selector: (OPTIONAL) If you can identify a CSS selector or specific way to find this element, provide it

OUTPUT FORMAT (JSON only):
{
  "actions": [
    {
      "type": "click",
      "element": "Submit button",
      "value": null,
      "timing": 1,
      "selector": null
    },
    {
      "type": "type",
      "element": "Email input field",
      "value": "user@example.com",
      "timing": 2,
      "selector": null
    },
    {
      "type": "select",
      "element": "Country dropdown",
      "value": "United States",
      "timing": 3,
      "selector": null
    },
    {
      "type": "checkbox",
      "element": "Accept terms",
      "value": "check",
      "timing": 4,
      "selector": null
    },
    {
      "type": "radio",
      "element": "Payment method",
      "value": "Credit Card",
      "timing": 5,
      "selector": null
    },
    {
      "type": "navigate",
      "element": "Home link",
      "value": null,
      "timing": 6,
      "selector": null
    }
  ],
  "videoDuration": 30
}

CRITICAL RULES:
- Only extract actions you can clearly see in the video frames
- Match element descriptions by visible text
- For typing, extract the exact text visible in the input field
- For dropdowns/selects:
  * Identify both the dropdown element and the selected option text
  * Cross-check against the provided website code to ensure action.value matches a REAL <option> text or value
  * If multiple options are similar, prefer the one whose text most closely matches what you see in the video
- For checkboxes/radios, identify by the label text next to them
- Maintain chronological order
- Be comprehensive - include ALL interactions, not just clicks and typing
- Output ONLY valid JSON, no markdown, no explanations`;

    const imageParts = frames.map(frame => {
      const frameData = frame.image.includes(',') ? frame.image.split(',')[1] : frame.image;
      return {
        inline_data: {
          mime_type: frame.image.startsWith('data:image/jpeg') ? "image/jpeg" : "image/png",
          data: frameData
        }
      };
    });

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            ...imageParts
          ]
        }]
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to extract actions');
    }

    const data = await response.json();
    const generatedText = data.candidates[0].content.parts[0].text;
    
    let cleanedText = generatedText.trim();
    if (cleanedText.includes('```json')) {
      cleanedText = cleanedText.match(/```json\s*([\s\S]*?)```/)?.[1] || cleanedText;
    } else if (cleanedText.includes('```')) {
      cleanedText = cleanedText.replace(/```/g, '').trim();
    }
    
    const actions = JSON.parse(cleanedText);
    console.log('[extractActionsFromVideo] Extracted', actions.actions?.length || 0, 'actions');
    return actions;
  } catch (error) {
    console.error('[extractActionsFromVideo] Error:', error);
    throw error;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getApiKey') {
    sendResponse({ apiKey: GEMINI_API_KEY });
    return true;
  }
  
  if (request.action === 'processVideo') {
    const apiKey = GEMINI_API_KEY || request.apiKey;
    if (!apiKey || apiKey === 'your_api_key_here' || (typeof apiKey === 'string' && apiKey.trim().length === 0)) {
      console.error('API key validation failed. GEMINI_API_KEY:', GEMINI_API_KEY, 'request.apiKey:', request.apiKey);
      sendResponse({ error: 'API key not configured. Please edit config.js and add your Gemini API key. See README.md for instructions.' });
      return true;
    }
    
    processVideoWithGemini(request.frames, apiKey, request.iteration, request.previousCode, request.previousScreenshot, request.previousFeedback, request.previousSummary)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'extractActions') {
    console.log('[background] Received extractActions request');
    const apiKey = GEMINI_API_KEY || request.apiKey;
    extractActionsFromVideo(request.frames, apiKey, request.code)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'analyzeSimilarity') {
    console.log('[background] Received analyzeSimilarity request');
    const apiKey = GEMINI_API_KEY || request.apiKey;
    if (!apiKey || apiKey === 'your_api_key_here' || (typeof apiKey === 'string' && apiKey.trim().length === 0)) {
      console.error('[background] API key not configured for similarity analysis');
      sendResponse({ error: 'API key not configured' });
      return true;
    }
    
    console.log('[background] Calling analyzeSimilarityWithGemini...');
    analyzeSimilarityWithGemini(request.screenshot, request.videoFrames, apiKey)
      .then(result => {
        console.log('[background] Similarity analysis result:', result);
        console.log('[background] Result size:', JSON.stringify(result).length, 'bytes');
        try {
          const responseSent = sendResponse(result);
          console.log('[background] sendResponse called, returned:', responseSent);
        } catch (e) {
          console.error('[background] Error sending response:', e);
          console.error('[background] Error stack:', e.stack);
        }
      })
      .catch(error => {
        console.error('[background] Error in similarity analysis:', error);
        console.error('[background] Error stack:', error.stack);
        try {
          sendResponse({ 
            error: error.message || 'Unknown error in similarity analysis',
            similarity: 0.5,
            feedback: [error.message || 'Analysis failed'],
            summary: 'Error occurred during analysis'
          });
        } catch (e) {
          console.error('[background] Error sending error response:', e);
        }
      });
    return true;
  }
  
  if (request.action === 'analyzeVideoSimilarity') {
    console.log('[background] Received analyzeVideoSimilarity request');
    const apiKey = GEMINI_API_KEY || request.apiKey;
    analyzeVideoSimilarityWithGemini(request.recordedVideoFrames, request.originalVideoFrames, apiKey)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message, similarity: 0.5, feedback: [error.message], summary: 'Video comparison failed' }));
    return true;
  }
  
  return false;
});

async function processVideoWithGemini(frames, apiKey, iteration, previousCode, previousScreenshot, previousFeedback, previousSummary) {
  try {
    const prompt = buildPrompt(frames, iteration, previousCode, previousScreenshot, previousFeedback, previousSummary);
    
    console.log('=== GEMINI PROMPT INFO ===');
    console.log('Prompt length:', prompt.length);
    console.log('Number of frames:', frames.length);
    console.log('Iteration:', iteration);
    console.log('Has previous code?', !!previousCode);
    console.log('Has previous screenshot?', !!previousScreenshot);
    console.log('Prompt contains "STEP 1"?', prompt.includes('STEP 1'));
    console.log('Prompt contains "MULTIPLE PAGES"?', prompt.includes('MULTIPLE PAGES'));
    console.log('Prompt contains "URL text"?', prompt.includes('URL text'));
    console.log('=== END PROMPT INFO ===');
    
    const imageParts = frames.map(frame => ({
      inline_data: {
        mime_type: "image/png",
        data: frame.image.split(',')[1]
      }
    }));
    
    if (previousScreenshot && iteration > 0) {
      imageParts.push({
        inline_data: {
          mime_type: "image/png",
          data: previousScreenshot.split(',')[1]
        }
      });
    }
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            ...imageParts
          ]
        }]
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      const errorMsg = error.error?.message || 'Failed to call Gemini API';
      throw new Error(errorMsg);
    }
    
    const data = await response.json();
    
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      throw new Error('Invalid response from Gemini API');
    }
    
    const generatedText = data.candidates[0].content.parts[0].text;
    
    console.log('=== GEMINI RAW OUTPUT ===');
    console.log('Full response length:', generatedText.length);
    console.log('First 1000 characters:', generatedText.substring(0, 1000));
    console.log('Last 1000 characters:', generatedText.substring(Math.max(0, generatedText.length - 1000)));
    console.log('Full response:', generatedText);
    console.log('=== END GEMINI RAW OUTPUT ===');
    
    const codeFiles = parseGeneratedCode(generatedText);
    
    console.log('=== PARSED CODE STRUCTURE ===');
    console.log('Has pages array?', !!codeFiles.pages);
    console.log('Has html field?', !!codeFiles.html);
    if (codeFiles.pages) {
      console.log('Number of pages:', codeFiles.pages.length);
      console.log('Page names:', codeFiles.pages.map(p => p.name));
    }
    console.log('Full parsed structure:', JSON.stringify(codeFiles, null, 2).substring(0, 2000));
    console.log('=== END PARSED CODE STRUCTURE ===');
    
    return { code: codeFiles };
  } catch (error) {
    console.error('Error processing video with Gemini:', error);
    throw error;
  }
}

async function analyzeSimilarityWithGemini(screenshot, videoFrames, apiKey) {
  try {
    console.log('[analyzeSimilarity] Starting similarity analysis...');
    console.log('[analyzeSimilarity] Screenshot provided:', !!screenshot);
    console.log('[analyzeSimilarity] Screenshot type:', typeof screenshot);
    console.log('[analyzeSimilarity] Screenshot length:', screenshot?.length || 0);
    console.log('[analyzeSimilarity] Video frames count:', videoFrames?.length || 0);
    
    if (!screenshot) {
      throw new Error('Screenshot is required for similarity analysis');
    }
    
    if (!videoFrames || videoFrames.length === 0) {
      throw new Error('Video frames are required for similarity analysis');
    }
    
    const prompt = buildSimilarityPrompt();
    console.log('[analyzeSimilarity] Prompt length:', prompt.length);
    
    const imageParts = [];
    
    if (screenshot) {
      const screenshotData = screenshot.includes(',') ? screenshot.split(',')[1] : screenshot;
      if (!screenshotData || screenshotData.length === 0) {
        throw new Error('Invalid screenshot data');
      }
      imageParts.push({
        inline_data: {
          mime_type: "image/png",
          data: screenshotData
        }
      });
      console.log('[analyzeSimilarity] Added screenshot to image parts, data length:', screenshotData.length);
    }
    
    if (videoFrames && videoFrames.length > 0) {
      let addedFrames = 0;
      videoFrames.forEach((frame, idx) => {
        if (!frame || !frame.image) {
          console.warn(`[analyzeSimilarity] Frame ${idx} is missing image data`);
          return;
        }
        const frameData = frame.image.includes(',') ? frame.image.split(',')[1] : frame.image;
        if (frameData && frameData.length > 0) {
          imageParts.push({
            inline_data: {
              mime_type: "image/png",
              data: frameData
            }
          });
          addedFrames++;
        } else {
          console.warn(`[analyzeSimilarity] Frame ${idx} has invalid image data`);
        }
      });
      console.log(`[analyzeSimilarity] Added ${addedFrames} video frames to image parts`);
    }
    
    if (imageParts.length === 0) {
      throw new Error('No valid images provided for similarity analysis');
    }
    
    console.log('[analyzeSimilarity] Total image parts:', imageParts.length);
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            ...imageParts
          ]
        }]
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      const errorMsg = error.error?.message || 'Failed to call Gemini API';
      throw new Error(errorMsg);
    }
    
    const data = await response.json();
    
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      throw new Error('Invalid response from Gemini API');
    }
    
    const generatedText = data.candidates[0].content.parts[0].text;
    
    console.log('[analyzeSimilarity] Gemini response length:', generatedText.length);
    console.log('[analyzeSimilarity] Gemini response preview:', generatedText.substring(0, 500));
    
    const analysis = parseSimilarityAnalysis(generatedText);
    
    console.log('[analyzeSimilarity] Parsed analysis:', analysis);
    
    return analysis;
  } catch (error) {
    console.error('[analyzeSimilarity] Error analyzing similarity with Gemini:', error);
    console.error('[analyzeSimilarity] Error stack:', error.stack);
    throw error;
  }
}

async function analyzeVideoSimilarityWithGemini(recordedVideoFrames, originalVideoFrames, apiKey) {
  try {
    console.log('[analyzeVideoSimilarity] Starting video comparison');
    console.log('[analyzeVideoSimilarity] Recorded frames:', recordedVideoFrames?.length || 0);
    console.log('[analyzeVideoSimilarity] Original frames:', originalVideoFrames?.length || 0);
    
    const prompt = buildVideoSimilarityPrompt();
    
    const imageParts = [];
    
    if (recordedVideoFrames && recordedVideoFrames.length > 0) {
      recordedVideoFrames.forEach((frame, idx) => {
        if (!frame || !frame.image) return;
        const frameData = frame.image.includes(',') ? frame.image.split(',')[1] : frame.image;
        imageParts.push({
          inline_data: {
            mime_type: "image/png",
            data: frameData
          }
        });
      });
      console.log('[analyzeVideoSimilarity] Added', recordedVideoFrames.length, 'recorded frames');
    }
    
    if (originalVideoFrames && originalVideoFrames.length > 0) {
      originalVideoFrames.forEach((frame, idx) => {
        if (!frame || !frame.image) return;
        const frameData = frame.image.includes(',') ? frame.image.split(',')[1] : frame.image;
        imageParts.push({
          inline_data: {
            mime_type: "image/png",
            data: frameData
          }
        });
      });
      console.log('[analyzeVideoSimilarity] Added', originalVideoFrames.length, 'original frames');
    }
    
    if (imageParts.length === 0) {
      throw new Error('No valid video frames provided for comparison');
    }
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            ...imageParts
          ]
        }]
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to compare videos');
    }
    
    const data = await response.json();
    const generatedText = data.candidates[0].content.parts[0].text;
    
    console.log('[analyzeVideoSimilarity] Gemini response length:', generatedText.length);
    
    const analysis = parseSimilarityAnalysis(generatedText);
    console.log('[analyzeVideoSimilarity] Parsed analysis:', analysis);
    
    return analysis;
  } catch (error) {
    console.error('[analyzeVideoSimilarity] Error:', error);
    throw error;
  }
}

function buildVideoSimilarityPrompt() {
  return `You are a web design analysis AI. Compare the recorded video of the generated website with the original video and provide an accurate similarity analysis.

CRITICAL: ONLY report ACTUAL differences you can see. DO NOT hallucinate or make up issues that don't exist.

TASK:
1. Compare the recorded video frames (first set of images) with the original video frames (second set of images)
2. Look for REAL, VISIBLE differences in:
   - Visual appearance (colors, fonts, layout, sizing)
   - Functionality (do interactions work the same way?)
   - User interactions (are the same actions possible?)
   - Navigation (do pages navigate correctly?)
3. Provide a similarity percentage (0-100%) based on actual visual and functional match
4. List ONLY specific, verifiable differences that need to be changed

ANALYSIS REQUIREMENTS - CHECK THESE CAREFULLY:
- Element sizing: Compare the actual size of elements (buttons, inputs, containers):
  * CRITICAL: Pay EXTRA attention to HORIZONTAL dimensions (widths):
    - Are button widths the same? Measure precisely
    - Are input field widths the same? Measure precisely
    - Are container widths the same? Measure precisely
    - Are column widths, sidebar widths, content area widths the same?
    - Is horizontal spacing between elements the same?
    - Is the overall page/container width the same?
  * Vertical dimensions (heights):
    - Are button heights the same?
    - Are input field heights the same?
    - Are container heights the same?
- Text fitting: Does text fit properly in its container?
  * Does text overflow horizontally? (most common issue)
  * Does text overflow vertically?
  * Is text clipped?
  * Is there awkward spacing, especially horizontal spacing?
  * Does text fit within the width of its container?
- Font sizes: Measure and compare font sizes - are they actually different or the same?
- Colors: Compare actual colors - are they different or the same? (be precise with hex codes)
- Spacing: Compare padding, margins, gaps between elements - are they actually different? Pay special attention to horizontal spacing
- Layout: Compare element positions and alignment - are they actually misaligned? Check horizontal alignment especially
- Element dimensions: Width, height, border-radius, etc. - are they actually different? Focus especially on width measurements

FORBIDDEN:
- DO NOT report issues that don't exist
- DO NOT make up differences
- DO NOT report things that are already correct
- DO NOT be overly critical - if something matches, don't mention it
- DO NOT report minor differences that are within acceptable tolerance

OUTPUT FORMAT (JSON only):
{
  "similarity": 85.5,
  "feedback": [
    "Heading font size appears to be 24px in recorded video but 28px in original",
    "Button width is 120px in recorded video but 150px in original",
    "Text in input field overflows container in recorded video but fits in original",
    "Navigation to second page works in original but fails in recorded video",
    "Submit button click works in original but does nothing in recorded video"
  ],
  "summary": "Overall good match but needs font size and element dimension adjustments, and navigation functionality needs fixing"
}

CRITICAL RULES:
- Only include feedback for differences you can ACTUALLY SEE when comparing recorded video to original video
- Be precise: include measurements (px values) when reporting size differences
- Focus on element sizing, text fitting, and functionality issues
- If something matches the original video, do NOT include it in feedback
- Provide similarity as a number between 0 and 100 based on actual visual and functional match
- Output ONLY valid JSON, no markdown, no explanations outside JSON`;
}

function parseSimilarityAnalysis(generatedText) {
  try {
    let cleanedText = generatedText.trim();
    
    if (cleanedText.includes('```json')) {
      const jsonMatch = cleanedText.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        cleanedText = jsonMatch[1].trim();
      }
    } else if (cleanedText.includes('```')) {
      const codeMatch = cleanedText.match(/```[a-z]*\s*([\s\S]*?)```/);
      if (codeMatch) {
        cleanedText = codeMatch[1].trim();
      }
    }
    
    cleanedText = cleanedText.replace(/^[^{]*?(\{)/, '$1');
    
    let firstBrace = cleanedText.indexOf('{');
    let lastBrace = cleanedText.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleanedText = cleanedText.substring(firstBrace, lastBrace + 1);
    }
    
    let braceCount = 0;
    let jsonStart = -1;
    let jsonEnd = -1;
    
    for (let i = 0; i < cleanedText.length; i++) {
      if (cleanedText[i] === '{') {
        if (jsonStart === -1) jsonStart = i;
        braceCount++;
      } else if (cleanedText[i] === '}') {
        braceCount--;
        if (braceCount === 0 && jsonStart !== -1) {
          jsonEnd = i;
          break;
        }
      }
    }
    
    if (jsonStart !== -1 && jsonEnd !== -1) {
      cleanedText = cleanedText.substring(jsonStart, jsonEnd + 1);
    }
    
    const analysis = JSON.parse(cleanedText);
    
    return {
      similarity: Math.min(100, Math.max(0, analysis.similarity || 50)) / 100,
      feedback: analysis.feedback || [],
      summary: analysis.summary || 'No summary provided'
    };
  } catch (error) {
    console.error('Error parsing similarity analysis:', error);
    
    const similarityMatch = generatedText.match(/(\d+(?:\.\d+)?)\s*%/);
    const similarity = similarityMatch ? Math.min(100, Math.max(0, parseFloat(similarityMatch[1]))) / 100 : 0.5;
    
    return {
      similarity: similarity,
      feedback: ['Could not parse detailed feedback from Gemini response'],
      summary: 'Analysis completed but parsing failed'
    };
  }
}

function buildPrompt(frames, iteration, previousCode, previousScreenshot, previousFeedback, previousSummary) {
  let prompt = `You are a web developer AI. Analyze the provided video frames and generate a complete website that matches what is shown in the video.

⚠️ IMPORTANT: Videos showing browser windows often contain MULTIPLE pages. Before proceeding, you MUST check the address bar in EVERY frame to detect multiple pages. Do not assume it's a single page.

CRITICAL: COPY EXACTLY - DO NOT ADD ANYTHING EXTRA
- Match the video EXACTLY as shown
- Do NOT add features, elements, or styling not visible in the video
- Do NOT improve or enhance beyond what is shown
- Do NOT add placeholder text, lorem ipsum, or example content
- Only include what you can see in the video frames

=== STEP 1: DETECT MULTIPLE PAGES (DO THIS FIRST - BEFORE ANYTHING ELSE) ===

🚨 CRITICAL INSTRUCTION: Look at the VERY TOP of each video frame. Do you see URL text at the top?

INSTRUCTIONS:
1. Examine the TOP EDGE of EVERY video frame
2. Look for URL text - it will be at the very top, usually in a browser address bar
3. The URL text might look like:
   - A full URL (e.g., "http://localhost:5500/filename.html")
   - Just a filename (e.g., "filename.html")
   - Any text that looks like a URL or filename
4. Compare the URL text across DIFFERENT frames:
   - Does the URL text CHANGE between frames?
   - Frame 1: What URL or filename does it show?
   - Frame 5: Does it show a DIFFERENT URL or filename?
   - Frame 10: Does it show yet another URL or the same one?
5. DECISION - BE STRICT AND ACCURATE:
   - IF you CANNOT see any URL text at the top of ANY frame → SINGLE PAGE → Use SINGLE PAGE structure
   - IF you see URL text but it stays the SAME in all frames → SINGLE PAGE → Use SINGLE PAGE structure
   - IF you see URL text AND it CHANGES between frames → MULTIPLE PAGES → Use MULTIPLE PAGES structure
6. Extract page names ONLY from what you ACTUALLY SEE in the video frames:
   - Look at the URL text in each frame
   - Extract the filename from the URL (the part after the last "/")
   - If you see a full URL, extract just the filename part
   - If you see just a filename, use that filename
   - DO NOT make up page names - ONLY use names you can see in the URL text
   - DO NOT guess or assume page names - ONLY extract what is visible
7. Create a list of ALL unique page names you ACTUALLY SEE in the URL text across all frames
   - If you only see one page name, you have a SINGLE PAGE
   - If you see multiple different page names, you have MULTIPLE PAGES

⚠️ CRITICAL RULES:
   - If you CANNOT see URL text at the top of frames, you MUST use SINGLE PAGE structure
   - DO NOT assume multiple pages if you cannot see the URL text
   - Only use MULTIPLE PAGES if you can CLEARLY see URL text that CHANGES between frames
   - When in doubt, use SINGLE PAGE structure

CRITICAL REQUIREMENTS - Pay EXTREMELY close attention to:
1. FONT FAMILY: Identify the exact font family used (e.g., Arial, Helvetica, Roboto, Inter, Georgia, Times New Roman, etc.). Use the EXACT same font family in your CSS. If you cannot identify it, use a very similar system font.
2. FONT SIZES: Measure and match font sizes EXACTLY. Use pixel values (px) and ensure headings, body text, buttons, and all text elements match the video frames precisely. Pay attention to:
   - Headings (h1, h2, h3) sizes
   - Body text size
   - Button text size
   - Navigation text size
   - Any other text elements
3. FONT WEIGHT: Match font weights exactly (normal, bold, 300, 400, 500, 600, 700, etc.)
4. LINE HEIGHT: Match line spacing and line heights
5. ELEMENT SIZING: Match element dimensions EXACTLY:
   - CRITICAL: Pay EXTRA attention to HORIZONTAL dimensions (widths):
     * Button widths - measure and match EXACTLY
     * Input field widths - measure and match EXACTLY
     * Container widths - measure and match EXACTLY
     * Column widths, sidebar widths, content area widths
     * Horizontal spacing between elements
     * Overall page/container width
   - Vertical dimensions (heights):
     * Button heights
     * Input field heights
     * Container heights
     * Image dimensions
   - All element dimensions must match the video precisely, with special focus on horizontal measurements
6. TEXT FITTING: Ensure text fits properly within its container:
   - Text should not overflow its container horizontally or vertically
   - Text should not be clipped
   - Padding around text should match the video (especially horizontal padding)
   - Text should be properly centered/aligned within buttons, inputs, etc.
   - Check that text has appropriate spacing and doesn't touch container edges
   - Pay special attention to how text fits within the horizontal width of containers
7. The layout and structure of the website (header, navigation, content areas, footer)
8. Navigation elements (buttons, links, menus) and where they lead when clicked
9. Visual styling (colors, spacing, borders, shadows, gradients, padding, margins)
10. Interactive elements and their behavior (hover effects, click animations, transitions)
11. Text content visible in the frames - COPY EXACTLY, do not paraphrase or add
12. Images, icons, and visual elements
11. MULTIPLE PAGES - REMINDER: You already checked this in STEP 1 above. If you detected multiple pages:
    - You MUST use the MULTIPLE PAGES JSON structure (see below)
    - Generate ALL pages that appear in the video - do not miss any
    - Each page should be a COMPLETE, STANDALONE HTML document (not sections that are shown/hidden)
    - Each page should have its own HTML structure but share the SAME CSS and JavaScript
    - Use the EXACT page names extracted from the address bar in STEP 1
    - Navigation links MUST use actual HTML anchor tags pointing to the page filenames you extracted
    - DO NOT use JavaScript show/hide (display:none/block) to simulate multiple pages
    - DO NOT use hash routing or JavaScript routing - use actual page URLs

${iteration > 0 ? `\n=== ITERATION ${iteration + 1} - TARGETED FIXES ONLY ===
This is iteration ${iteration + 1}. You MUST make MINIMAL, TARGETED changes.

CRITICAL RULES FOR ITERATIONS:
1. ONLY fix the specific issues listed in the feedback below
2. Keep EVERYTHING else exactly the same - do not regenerate working code
3. Make surgical, precise changes - only modify the CSS/HTML/JS for the specific issues
4. DO NOT rewrite entire sections - only change what's needed
5. DO NOT touch code that wasn't mentioned in feedback
6. Pay special attention to element sizing and text fitting issues

${previousFeedback && previousFeedback.length > 0 ? `\n=== SPECIFIC FEEDBACK TO FIX ===
Fix ONLY these specific issues (do not change anything else):
${previousFeedback.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}

${previousSummary ? `Summary: ${previousSummary}` : ''}

CRITICAL INSTRUCTIONS:
- For each feedback item above, find the corresponding code and fix ONLY that specific issue
- If feedback mentions "font size is X but should be Y" - change ONLY that font-size property
- If feedback mentions "element width is X but should be Y" - change ONLY that width property
- If feedback mentions "text overflow" - adjust ONLY padding/sizing to fix text fitting
- Keep all other code unchanged
- Do not regenerate HTML structure unless feedback specifically mentions it
- Do not change colors, spacing, or styling that wasn't mentioned in feedback
- Pay close attention to element dimensions and how text fits within containers` : 'No specific feedback provided - compare screenshot with video to identify differences.'}

${previousScreenshot ? 'A screenshot of the previous attempt is included. Use it to verify what currently exists before making changes.' : ''}

Previous code summary:
- HTML structure: ${previousCode?.html ? previousCode.html.substring(0, 300) + '...' : 'N/A'}
- CSS styling: ${previousCode?.css ? previousCode.css.substring(0, 300) + '...' : 'N/A'}
- JavaScript: ${previousCode?.js ? previousCode.js.substring(0, 300) + '...' : 'N/A'}

REMEMBER: Make minimal changes. Only fix what's in the feedback. Keep everything else identical.` : ''}

=== FINAL CHECK: MULTIPLE PAGES DETECTION ===
🚨 STOP. Before generating JSON, answer these questions HONESTLY:

1. Look at the VERY TOP of Frame 1 - can you CLEARLY see URL text? YES or NO?
2. Look at the VERY TOP of Frame 5 - can you CLEARLY see URL text? YES or NO?
3. Look at the VERY TOP of Frame 10 - can you CLEARLY see URL text? YES or NO?
4. If you answered NO to all questions → Use SINGLE PAGE JSON structure
5. If you answered YES to any question, compare: Does the URL text CHANGE between frames?
   - YES (URL clearly changes) → MULTIPLE PAGES → Use MULTIPLE PAGES JSON structure
   - NO (URL stays same or unclear) → SINGLE PAGE → Use SINGLE PAGE JSON structure

⚠️ CRITICAL: If you CANNOT clearly see URL text, you MUST use SINGLE PAGE structure.
⚠️ DO NOT guess or assume - only use MULTIPLE PAGES if you can CLEARLY see URL text that CHANGES.
⚠️ When in doubt, use SINGLE PAGE structure.

Generate the website code as a JSON object. Use ONE of the following structures:

SINGLE PAGE (if only one page is shown in the video - NO URL changes detected):
{
  "html": "<!DOCTYPE html><html><head><title>Page Title</title></head><body>...complete HTML with ALL structure, elements, and content visible in the video...</body></html>",
  "css": "/* Complete CSS with ALL styling - MUST include exact font-family, font-size, colors, spacing, layout, dimensions for ALL elements. Include styles for buttons, inputs, containers, text, images, and all visual elements shown in the video. */",
  "js": "// Complete JavaScript with ALL interactions - ensure ALL interactive elements work correctly. Include event handlers, click handlers, form validations, hover effects, and all functionality shown in the video."
}

CRITICAL FOR SINGLE PAGE:
- The "html" field MUST contain a COMPLETE, valid HTML document with <!DOCTYPE html>, <html>, <head>, and <body> tags
- Include ALL HTML structure visible in the video - headers, navigation, content sections, buttons, forms, images, text, etc.
- The HTML must be a complete, standalone page that works when loaded
- The "css" field MUST contain ALL CSS styling needed - fonts, colors, spacing, layout, dimensions, borders, shadows, etc.
- The "js" field MUST contain ALL JavaScript functionality - event listeners, DOM manipulation, form handling, interactions, etc.
- Do NOT include CSS or JS in the HTML field - put them in separate "css" and "js" fields
- The HTML should NOT have <style> or <script> tags - we will inject the CSS and JS separately
- Ensure the HTML structure matches the video exactly - same elements, same hierarchy, same content

MULTIPLE PAGES (USE THIS ONLY if you see DIFFERENT page names in the address bar across frames):
{
  "css": "/* Complete CSS with all styling - MUST include exact font-family and font-size for all elements. This CSS will be shared across ALL pages. CRITICAL: All pages must have IDENTICAL styling - same fonts, colors, spacing, layout styles. */",
  "js": "// Complete JavaScript with all interactions - ensure all interactive elements work correctly. This JavaScript will be shared across ALL pages. CRITICAL: All pages must have IDENTICAL JavaScript functionality - same event handlers, same interactive behaviors, same functions.",
  "startingPage": "filename.html",
  "pages": [
    {
      "name": "filename.html",
      "html": "<!DOCTYPE html><html>...complete HTML for the page shown when address bar displays this filename. Include navigation links to other pages...</html>"
    },
    {
      "name": "other-filename.html",
      "html": "<!DOCTYPE html><html>...complete HTML for the page shown when address bar displays this filename. Include navigation links to other pages...</html>"
    }
  ]
}

🚨 CRITICAL: PAGE NAME EXTRACTION RULES:
- The "name" field for each page MUST be EXTRACTED from the URL text you see in the video frames
- DO NOT invent, guess, or hardcode page names
- ONLY use page names that you can ACTUALLY SEE in the address bar/URL text of the video frames
- Extract the filename from the URL (the part after the last "/")
- If you see a full URL, extract just the filename part
- If you see just a filename, use that filename exactly as shown
- The "startingPage" field must be the page name that appears in the FIRST frame(s) of the video
- Use the EXACT filename you see - do not modify or change it
- Each page's HTML must be a COMPLETE, STANDALONE HTML document - NOT a section that gets shown/hidden
- Navigation links MUST be real HTML anchor tags pointing to the actual page filenames you extracted
- When the user clicks a link, the browser MUST navigate to the actual URL
- FORBIDDEN: DO NOT use JavaScript show/hide (display:none/block) to simulate pages
- FORBIDDEN: DO NOT use onclick handlers that preventDefault() and change content
- FORBIDDEN: DO NOT create a single page with multiple divs that you toggle visibility
- REQUIRED: Each page must work when accessed directly via its URL
- REQUIRED: Browser back/forward buttons must work normally between pages

Requirements:
- FIRST (STEP 1): Check EVERY frame's address bar at the TOP of the browser window for different page URLs
- The address bar is at the VERY TOP of the browser - look for URL text
- Even if the address bar is small or partially visible, you MUST check it in every frame
- If you see different URLs in the address bar across frames, you MUST use the MULTIPLE PAGES structure
- Extract the EXACT page names from the URLs you see - use the filename part of the URL
- DO NOT use generic or assumed names - ONLY use what you actually see
- DO NOT invent or guess page names - ONLY use names you can see in the URL text
- If you see the same URL throughout all frames, use the SINGLE PAGE structure
- DO NOT assume single page - actively check the address bar in each frame
- FALLBACK: If address bar is not clearly visible but you see MAJOR content changes between frames (completely different page layouts, different titles, different main content), this also indicates multiple pages
- For multiple pages: CSS and JavaScript must be IDENTICAL across all pages (shared in the root css and js fields)
- CRITICAL: All pages MUST have the EXACT same styling:
  * Same font families, font sizes, font weights, line heights
  * Same colors, spacing, padding, margins
  * Same layout styles, borders, shadows, effects
  * Same button styles, link styles, form styles
  * The CSS in the "css" field will be applied to ALL pages - make sure it's complete
- CRITICAL: All pages MUST have the EXACT same JavaScript functionality:
  * Same event handlers, same interactive behaviors
  * Same functions, same logic
  * Same click handlers, hover effects, form validations
  * The JavaScript in the "js" field will be applied to ALL pages - make sure it's complete
- CRITICAL: Pay EXTREME attention to element sizing and text fitting:
  * CRITICAL: Give EXTRA attention to HORIZONTAL dimensions (widths):
    - Match button widths EXACTLY as shown in video - measure precisely
    - Match input field widths EXACTLY as shown in video - measure precisely
    - Match container widths EXACTLY as shown in video - measure precisely
    - Match column widths, sidebar widths, content area widths EXACTLY
    - Match horizontal spacing between elements EXACTLY
    - Match overall page/container width EXACTLY
  * Vertical dimensions (heights):
    - Match button heights EXACTLY as shown in video
    - Match input field heights EXACTLY as shown in video
    - Match container heights EXACTLY as shown in video
  * Ensure text fits properly within containers - no overflow, no clipping (especially horizontal overflow)
  * Match padding around text to ensure proper spacing (especially horizontal padding)
  * Verify button/input dimensions match the video precisely (especially widths)
  * Check that text is properly centered/aligned within its container (especially horizontally)
- For SINGLE PAGE: The HTML field must be a complete, standalone HTML document with ALL structure and content
- For SINGLE PAGE: Do NOT include <style> or <script> tags in the HTML - put CSS in "css" field and JS in "js" field
- For MULTIPLE PAGES: Each page's HTML should be complete and standalone (we'll inject shared CSS and JS)
- Include all CSS in the css field (we'll inject it)
- Include all JavaScript in the js field (we'll inject it)
- CRITICAL FOR MULTIPLE PAGES: 
  * Each page MUST be a completely separate, independent HTML document
  * Navigation links MUST use actual HTML anchor tags with href pointing to the page filename you extracted from the video
  * DO NOT use JavaScript to show/hide different sections on a single page
  * DO NOT use display:none/block or visibility to switch between pages
  * DO NOT use hash routing (e.g., <a href="#binary">) 
  * DO NOT use JavaScript routing or event handlers that preventDefault() on links
  * DO NOT use relative paths without the filename (e.g., <a href="/binary">)
  * Each page should be navigable by directly accessing its URL
  * When a user clicks a navigation link, it should cause a full page navigation (browser loads the new page)
  * Use the exact page name as shown in the video's address bar as the href value
  * Each page's HTML should be complete and standalone - do not rely on JavaScript to show/hide content to simulate multiple pages
- Match colors, fonts, font sizes, and layout as closely as possible
- Include all interactive elements (buttons, links, forms, etc.)
- Ensure JavaScript is correct and functional - test logic in your mind before outputting
- Use proper event listeners and DOM manipulation
- Ensure all click handlers, hover effects, and interactions work as shown in the video
- Extract and use the EXACT page names you see in the video's address bar - DO NOT hardcode or assume names
- Use the filename exactly as it appears in the URL text you see
- ONLY use page names that you can ACTUALLY SEE in the video frames' URL text
${iteration > 0 ? '- IMPORTANT: Only change what needs to be fixed. Keep working parts unchanged.' : ''}

🚨 CRITICAL: FORBIDDEN FOR MULTIPLE PAGES - DO NOT DO THIS:
- DO NOT use JavaScript to show/hide sections with display:none or visibility:hidden
- DO NOT use JavaScript event handlers that preventDefault() on links
- DO NOT create a single HTML page with multiple divs that you show/hide
- DO NOT use hash routing (#page) or JavaScript routing
- DO NOT use onclick handlers that change content without navigating

✅ REQUIRED FOR MULTIPLE PAGES - YOU MUST DO THIS:
- Each page MUST be a completely separate HTML document in the "pages" array
- Navigation links MUST be real HTML anchor tags pointing to the actual page filenames you extracted
- When clicked, links MUST cause the browser to navigate to the actual URL
- Each page should work independently when accessed directly via its URL
- The browser's back/forward buttons should work normally

CORRECT navigation format:
<a href="actual-filename.html">Link Text</a>  ← Use the actual filename you see in the video

WRONG navigation formats:
<div onclick="showPage('page')">Link</div>  ← DO NOT use JavaScript show/hide
<a href="#" onclick="showPage()">Link</a>  ← DO NOT use JavaScript routing

🚨 FINAL REMINDER FOR SINGLE PAGE:
- If you determined this is a SINGLE PAGE, use the SINGLE PAGE JSON structure
- The "html" field MUST be a complete, valid HTML document - include <!DOCTYPE html>, <html>, <head>, <body> tags
- Include ALL visible content, structure, and elements in the HTML
- Put ALL CSS in the "css" field - do NOT put CSS in the HTML
- Put ALL JavaScript in the "js" field - do NOT put JS in the HTML
- The HTML should work as a standalone page when the CSS and JS are injected

Output ONLY valid JSON, no markdown code blocks, no explanations, just the JSON object.`;

  return prompt;
}

function parseGeneratedCode(generatedText) {
  try {
    let cleanedText = generatedText.trim();
    
    if (cleanedText.includes('```json')) {
      const jsonMatch = cleanedText.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        cleanedText = jsonMatch[1].trim();
      } else {
        cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      }
    } else if (cleanedText.includes('```')) {
      const codeMatch = cleanedText.match(/```[a-z]*\s*([\s\S]*?)```/);
      if (codeMatch) {
        cleanedText = codeMatch[1].trim();
      } else {
        cleanedText = cleanedText.replace(/```[a-z]*\n?/g, '').replace(/```\n?/g, '');
      }
    }
    
    cleanedText = cleanedText.replace(/^[^{]*?(\{)/, '$1');
    
    let firstBrace = cleanedText.indexOf('{');
    let lastBrace = cleanedText.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleanedText = cleanedText.substring(firstBrace, lastBrace + 1);
    }
    
    let braceCount = 0;
    let jsonStart = -1;
    let jsonEnd = -1;
    
    for (let i = 0; i < cleanedText.length; i++) {
      if (cleanedText[i] === '{') {
        if (jsonStart === -1) jsonStart = i;
        braceCount++;
      } else if (cleanedText[i] === '}') {
        braceCount--;
        if (braceCount === 0 && jsonStart !== -1) {
          jsonEnd = i;
          break;
        }
      }
    }
    
    if (jsonStart !== -1 && jsonEnd !== -1) {
      cleanedText = cleanedText.substring(jsonStart, jsonEnd + 1);
    }
    
    const codeFiles = JSON.parse(cleanedText);
    
    console.log('[parseGeneratedCode] Parsed JSON successfully');
    console.log('[parseGeneratedCode] Has pages?', !!codeFiles.pages);
    console.log('[parseGeneratedCode] Has css?', !!codeFiles.css, 'Length:', codeFiles.css?.length || 0);
    console.log('[parseGeneratedCode] Has js?', !!codeFiles.js, 'Length:', codeFiles.js?.length || 0);
    console.log('[parseGeneratedCode] CSS preview:', codeFiles.css?.substring(0, 200) || 'NONE');
    console.log('[parseGeneratedCode] JS preview:', codeFiles.js?.substring(0, 200) || 'NONE');
    
    if (codeFiles.pages && Array.isArray(codeFiles.pages)) {
      console.log('[parseGeneratedCode] Multi-page format detected, processing pages...');
      const startingPage = codeFiles.startingPage || codeFiles.pages[0]?.name || 'index.html';
      console.log('[parseGeneratedCode] Starting page detected:', startingPage);
      const result = {
        css: codeFiles.css || '/* No CSS generated */',
        js: codeFiles.js || '// No JavaScript generated',
        startingPage: startingPage,
        pages: codeFiles.pages.map(page => ({
          name: page.name || 'index.html',
          html: page.html || '<html><body>No HTML generated</body></html>'
        }))
      };
      console.log('[parseGeneratedCode] Returning multi-page structure with', result.pages.length, 'pages');
      console.log('[parseGeneratedCode] Starting page:', result.startingPage);
      console.log('[parseGeneratedCode] Final CSS length:', result.css.length);
      console.log('[parseGeneratedCode] Final JS length:', result.js.length);
      return result;
    }
    
    return {
      html: codeFiles.html || '<html><body>No HTML generated</body></html>',
      css: codeFiles.css || '/* No CSS generated */',
      js: codeFiles.js || '// No JavaScript generated'
    };
  } catch (error) {
    console.error('Error parsing generated code:', error);
    
    const patterns = [
      /\{[\s\S]*?"html"[\s\S]*?"css"[\s\S]*?"js"[\s\S]*?\}/,
      /\{[\s\S]*?"html":[\s\S]*?"css":[\s\S]*?"js":[\s\S]*?\}/,
      /\{[\s\S]{100,}\}/,
    ];
    
    for (const pattern of patterns) {
      try {
        const jsonMatch = generatedText.match(pattern);
        if (jsonMatch) {
          const codeFiles = JSON.parse(jsonMatch[0]);
          
          if (codeFiles.pages && Array.isArray(codeFiles.pages)) {
            const startingPage = codeFiles.startingPage || codeFiles.pages[0]?.name || 'index.html';
            return {
              css: codeFiles.css || '/* No CSS generated */',
              js: codeFiles.js || '// No JavaScript generated',
              startingPage: startingPage,
              pages: codeFiles.pages.map(page => ({
                name: page.name || 'index.html',
                html: page.html || '<html><body>No HTML generated</body></html>'
              }))
            };
          }
          
          return {
            html: codeFiles.html || '<html><body>No HTML generated</body></html>',
            css: codeFiles.css || '/* No CSS generated */',
            js: codeFiles.js || '// No JavaScript generated'
          };
        }
      } catch (e) {
        continue;
      }
    }
    
    return {
      html: extractCodeBlock(generatedText, 'html') || '<html><body>Error parsing code. Check console for details.</body></html>',
      css: extractCodeBlock(generatedText, 'css') || '/* Error parsing CSS */',
      js: extractCodeBlock(generatedText, 'javascript') || '// Error parsing JavaScript'
    };
  }
}

function extractCodeBlock(text, language) {
  const regex = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}
