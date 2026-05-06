// netlify/functions/transcribe.js
// Mode 1: caption - called from editor caption drawer
// Mode 2: aidetect - Whisper + GPT-4o Mini finds best clips with grades + captions
// OPENAI_API_KEY must be set in Netlify environment variables

exports.handler = async function(event) {

  if(event.httpMethod !== 'POST'){
    return { statusCode:405, body:JSON.stringify({error:'Method not allowed'}) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if(!apiKey){
    return { statusCode:500, body:JSON.stringify({error:'OPENAI_API_KEY not configured'}) };
  }

  try{
    const body = JSON.parse(event.body);
    const { audio, mimeType, mode, type, topic, keywords, duration } = body;

    if(!audio){
      return { statusCode:400, body:JSON.stringify({error:'No audio provided'}) };
    }

    // STEP 1: WHISPER TRANSCRIPTION
    const whisperResult = await callWhisper(audio, mimeType, apiKey);
    if(!whisperResult.ok){
      return { statusCode:500, body:JSON.stringify({error:'Whisper failed: ' + whisperResult.error}) };
    }

    const { transcript, segments, whisperDuration } = whisperResult;

    // Caption mode - just return transcript segments
    if(mode !== 'aidetect'){
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, segments, duration: whisperDuration }),
      };
    }

    // STEP 2: GPT-4o MINI CLIP ANALYSIS
    if(!transcript || transcript.trim().length < 20){
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript, segments,
          clips: [],
          error: 'Not enough speech detected for AI analysis'
        }),
      };
    }

    const gptResult = await callGPT(transcript, segments, type, topic, keywords, duration, apiKey);
    if(!gptResult.ok){
      // GPT failed - return transcript only, browser falls back to segment list
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, segments, clips: [], gptError: gptResult.error }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript,
        segments,
        clips: gptResult.clips,
        duration: whisperDuration,
      }),
    };

  }catch(err){
    console.error('Function error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Internal server error' }),
    };
  }
};

// WHISPER
async function callWhisper(audioBase64, mimeType, apiKey){
  try{
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const boundary = '----SCBoundary' + Date.now();

    const textParts = [
      '--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n',
      '--' + boundary + '\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n',
      '--' + boundary + '\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment\r\n',
    ].join('');

    const fileHeader =
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="clip.webm"\r\n' +
      'Content-Type: ' + (mimeType || 'audio/webm') + '\r\n\r\n';

    const closing = '\r\n--' + boundary + '--\r\n';

    const multipartBody = Buffer.concat([
      Buffer.from(textParts + fileHeader, 'utf8'),
      audioBuffer,
      Buffer.from(closing, 'utf8'),
    ]);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
      },
      body: multipartBody,
    });

    if(!res.ok){
      const errText = await res.text();
      return { ok:false, error:'Whisper ' + res.status + ': ' + errText.slice(0,200) };
    }

    const result = await res.json();
    const segments = (result.segments || []).map(seg => ({
      start: parseFloat(seg.start) || 0,
      end:   parseFloat(seg.end)   || 0,
      text:  (seg.text || '').trim(),
    })).filter(seg => seg.text.length > 0);

    return {
      ok: true,
      transcript: result.text || '',
      segments,
      whisperDuration: result.duration || 0,
    };

  }catch(err){
    return { ok:false, error: err.message };
  }
}

// GPT-4o MINI
async function callGPT(transcript, segments, type, topic, keywords, duration, apiKey){
  try{
    const typeLabel = type || 'general';
    const topicLabel = topic || 'general';
    const keywordsLabel = keywords || '';
    const totalDur = duration || 0;

    const systemPrompt = 'You are a viral content strategist who identifies the most shareable moments in video transcripts. You always return valid JSON only - no markdown, no explanation outside the JSON.';

    const userPrompt = 'Analyze this video transcript and find the 5-8 best clips for social media.\n\n' +
      'VIDEO CONTEXT:\n' +
      '- Type: ' + typeLabel + '\n' +
      '- Topic: ' + topicLabel + '\n' +
      '- Keywords to prioritize: ' + (keywordsLabel || 'none specified') + '\n' +
      '- Total duration: ' + Math.round(totalDur) + ' seconds\n\n' +
      'TRANSCRIPT WITH TIMESTAMPS:\n' +
      segments.map(s => '[' + s.start.toFixed(1) + 's-' + s.end.toFixed(1) + 's] ' + s.text).join('\n') + '\n\n' +
      'RULES:\n' +
      '1. Each clip must be a COMPLETE THOUGHT - never cut mid-sentence\n' +
      '2. Clip length: 15-90 seconds\n' +
      '3. Prioritize moments that are: quotable, surprising, emotional, actionable, or funny\n' +
      '4. Grade each clip: A (90-100), B (75-89), C (60-74), D (below 60)\n' +
      '5. Include exact transcript sentences as captions array\n\n' +
      'Return ONLY this JSON:\n' +
      '{"clips":[{"start":14.2,"end":47.8,"reason":"why shareable","grade":"A","score":88,"captions":[{"start":14.2,"end":19.5,"text":"sentence here"}]}]}';

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    if(!res.ok){
      const errText = await res.text();
      return { ok:false, error:'GPT ' + res.status + ': ' + errText.slice(0,200) };
    }

    const result = await res.json();
    const content = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content || '{}';

    let parsed;
    try{
      parsed = JSON.parse(content);
    }catch(e){
      return { ok:false, error:'GPT returned invalid JSON' };
    }

    const clips = (parsed.clips || []).map(clip => ({
      start:    parseFloat(clip.start) || 0,
      end:      parseFloat(clip.end)   || 0,
      reason:   clip.reason || '',
      grade:    clip.grade  || 'C',
      score:    parseInt(clip.score) || 60,
      captions: (clip.captions || []).map(c => ({
        start: parseFloat(c.start) || 0,
        end:   parseFloat(c.end)   || 0,
        text:  (c.text || '').trim(),
      })),
    })).filter(c => c.end > c.start);

    return { ok:true, clips };

  }catch(err){
    return { ok:false, error: err.message };
  }
}
