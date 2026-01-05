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
    
    processVideoWithGemini(request.frames, apiKey, request.iteration, request.previousCode, request.previousScreenshot)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

async function processVideoWithGemini(frames, apiKey, iteration, previousCode, previousScreenshot) {
  try {
    const prompt = buildPrompt(frames, iteration, previousCode, previousScreenshot);
    
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
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=${apiKey}`;
    
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

function buildPrompt(frames, iteration, previousCode, previousScreenshot) {
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
5. The layout and structure of the website (header, navigation, content areas, footer)
6. Navigation elements (buttons, links, menus) and where they lead when clicked
7. Visual styling (colors, spacing, borders, shadows, gradients, padding, margins)
8. Interactive elements and their behavior (hover effects, click animations, transitions)
9. Text content visible in the frames - COPY EXACTLY, do not paraphrase or add
10. Images, icons, and visual elements
11. MULTIPLE PAGES - REMINDER: You already checked this in STEP 1 above. If you detected multiple pages:
    - You MUST use the MULTIPLE PAGES JSON structure (see below)
    - Generate ALL pages that appear in the video - do not miss any
    - Each page should be a COMPLETE, STANDALONE HTML document (not sections that are shown/hidden)
    - Each page should have its own HTML structure but share the SAME CSS and JavaScript
    - Use the EXACT page names extracted from the address bar in STEP 1
    - Navigation links MUST use actual HTML anchor tags pointing to the page filenames you extracted
    - DO NOT use JavaScript show/hide (display:none/block) to simulate multiple pages
    - DO NOT use hash routing or JavaScript routing - use actual page URLs

${iteration > 0 ? `\n=== ITERATION ${iteration + 1} - DIFFERENCE ANALYSIS REQUIRED ===
This is iteration ${iteration + 1}. You MUST analyze the differences between:
1. The video frames (what it SHOULD look like)
2. The previous screenshot (what it CURRENTLY looks like)
3. The previous code (what was generated)

CRITICAL: Before generating new code, you MUST:
1. Compare the previous SCREENSHOT with the video frames - identify visual differences
2. Compare the previous CODE with what the video shows - identify code issues
3. Identify SPECIFIC differences:
   - What fonts/font sizes are wrong? (compare screenshot to video)
   - What colors don't match? (compare screenshot to video)
   - What spacing/padding/margins are incorrect? (compare screenshot to video)
   - What layout elements are missing or wrong? (compare screenshot to video)
   - What interactive elements don't work or are missing? (check code functionality)
   - What text content is wrong or missing? (compare screenshot to video)
4. ONLY modify the parts that need fixing - keep everything else the same
5. Make targeted, precise changes rather than regenerating everything
6. DO NOT add anything not in the video - copy exactly
7. If multiple pages were detected, maintain separate HTML pages - DO NOT convert to JavaScript show/hide
8. Keep navigation as actual HTML links (<a href="page.html">) - DO NOT change to JavaScript routing

Previous code summary:
- HTML structure: ${previousCode.html ? previousCode.html.substring(0, 300) + '...' : 'N/A'}
- CSS styling: ${previousCode.css ? previousCode.css.substring(0, 300) + '...' : 'N/A'}
- JavaScript: ${previousCode.js ? previousCode.js.substring(0, 300) + '...' : 'N/A'}

${previousScreenshot ? 'A screenshot of the previous attempt is included. Compare it directly with the video frames to see what needs to be fixed.' : ''}

Focus on fixing ONLY the identified differences. Do not rewrite code that already matches the video.` : ''}

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

SINGLE PAGE (if only one page is shown in the video):
{
  "html": "<!DOCTYPE html><html>...complete HTML with all structure...</html>",
  "css": "/* Complete CSS with all styling - MUST include exact font-family and font-size for all elements */",
  "js": "// Complete JavaScript with all interactions - ensure all interactive elements work correctly"
}

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
- 🚨 CRITICAL: All pages MUST have the EXACT same styling:
  * Same font families, font sizes, font weights, line heights
  * Same colors, spacing, padding, margins
  * Same layout styles, borders, shadows, effects
  * Same button styles, link styles, form styles
  * The CSS in the "css" field will be applied to ALL pages - make sure it's complete
- 🚨 CRITICAL: All pages MUST have the EXACT same JavaScript functionality:
  * Same event handlers, same interactive behaviors
  * Same functions, same logic
  * Same click handlers, hover effects, form validations
  * The JavaScript in the "js" field will be applied to ALL pages - make sure it's complete
- Each page's HTML should include the shared CSS and JS (in <style> and <script> tags)
- The HTML should be a complete, standalone page
- Include all CSS in a <style> tag or the css field (we'll inject it)
- Include all JavaScript in a <script> tag or the js field (we'll inject it)
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
