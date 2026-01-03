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
    
    processVideoWithGemini(request.frames, apiKey, request.iteration, request.previousCode)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

async function processVideoWithGemini(frames, apiKey, iteration, previousCode) {
  try {
    const prompt = buildPrompt(frames, iteration, previousCode);
    
    const imageParts = frames.map(frame => ({
      inline_data: {
        mime_type: "image/png",
        data: frame.image.split(',')[1]
      }
    }));
    
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
    const codeFiles = parseGeneratedCode(generatedText);
    
    return { code: codeFiles };
  } catch (error) {
    console.error('Error processing video with Gemini:', error);
    throw error;
  }
}

function buildPrompt(frames, iteration, previousCode) {
  let prompt = `You are a web developer AI. Analyze the provided video frames and generate a complete website that matches what is shown in the video.

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
9. Text content visible in the frames
10. Images, icons, and visual elements

${iteration > 0 ? `This is iteration ${iteration + 1}. The previous code had some issues or didn't match the video closely enough. Please refine it to better match the video frames, especially font sizes and font families.` : ''}

${previousCode ? `Previous code:\nHTML: ${previousCode.html.substring(0, 500)}...\nCSS: ${previousCode.css.substring(0, 500)}...\nJS: ${previousCode.js.substring(0, 500)}...\n\nPlease improve upon this code to better match the video, with special attention to fonts and font sizes.` : ''}

Generate the website code as a JSON object with the following structure:
{
  "html": "<!DOCTYPE html><html>...complete HTML with all structure...</html>",
  "css": "/* Complete CSS with all styling - MUST include exact font-family and font-size for all elements */",
  "js": "// Complete JavaScript with all interactions - ensure all interactive elements work correctly"
}

Requirements:
- The HTML should be a complete, standalone page
- Include all CSS in a <style> tag or the css field (we'll inject it)
- Include all JavaScript in a <script> tag or the js field (we'll inject it)
- Make sure navigation works (use hash routing or show/hide sections)
- Match colors, fonts, font sizes, and layout as closely as possible
- Include all interactive elements (buttons, links, forms, etc.)
- Ensure JavaScript is correct and functional - test logic in your mind before outputting
- Use proper event listeners and DOM manipulation
- Ensure all click handlers, hover effects, and interactions work as shown in the video

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
