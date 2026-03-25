import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from "@google/genai";
import cookieParser from 'cookie-parser';
import cors from 'cors';

dotenv.config();

const getGeminiKey = () => {
  const key = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  if (key === 'MY_GEMINI_API_KEY' || !key) return '';
  return key;
};

const ai = new GoogleGenAI({ apiKey: getGeminiKey() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_IDS = [
  process.env.SOUNDCLOUD_CLIENT_ID,
  'KKzJxmw11tYpCs6T24P4uUYhqmjalG6M'
].filter(Boolean) as string[];

// Remove problematic IDs if they appear
const BLACKLISTED_STATIC_IDS: string[] = [];
const FINAL_CLIENT_IDS = CLIENT_IDS.filter(id => !BLACKLISTED_STATIC_IDS.includes(id));

const SC_API_BASE = 'https://api-v2.soundcloud.com';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const GENIUS_ACCESS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;
const GENIUS_CLIENT_ID = process.env.GENIUS_CLIENT_ID;
const GENIUS_CLIENT_SECRET = process.env.GENIUS_CLIENT_SECRET;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// SoundCloud API Helper with intelligent rotation
class SoundCloudAPI {
  private static currentIndex = 0;
  private static blacklistedIds = new Set<string>();

  static async fetch(path: string, params: Record<string, any> = {}) {
    let availableIds = FINAL_CLIENT_IDS.filter(id => !this.blacklistedIds.has(id));
    
    if (availableIds.length === 0) {
      console.error('All SoundCloud Client IDs are blacklisted! Resetting blacklist.');
      this.blacklistedIds.clear();
      availableIds = [...FINAL_CLIENT_IDS];
    }

    // Try starting from the last successful index (or current index)
    for (let i = 0; i < FINAL_CLIENT_IDS.length; i++) {
      const index = (this.currentIndex + i) % FINAL_CLIENT_IDS.length;
      const clientId = FINAL_CLIENT_IDS[index];

      if (this.blacklistedIds.has(clientId)) continue;

      const queryParams = new URLSearchParams({ ...params, client_id: clientId });
      const separator = path.includes('?') ? '&' : '?';
      const url = path.startsWith('http') 
        ? `${path}${separator}client_id=${clientId}`
        : `${SC_API_BASE}${path}${separator}${queryParams.toString()}`;

      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://soundcloud.com',
            'Referer': 'https://soundcloud.com/'
          }
        });
        
        if (response.ok) {
          this.currentIndex = index; // Remember this working ID
          return response;
        }

        // If we get 401, 403, or 404 on a general endpoint, it's likely a bad ID
        const isGeneralEndpoint = path.includes('/charts') || path.includes('/search') || path.includes('/tracks');
        
        if (response.status === 401 || response.status === 403 || (response.status === 404 && isGeneralEndpoint)) {
          console.warn(`[SoundCloud] Blacklisting client_id ${clientId.substring(0, 5)}... due to ${response.status} on ${path}`);
          this.blacklistedIds.add(clientId);
          continue; // Try next ID immediately
        } else {
          console.warn(`[SoundCloud] API failed with client_id ${clientId.substring(0, 5)}... (${response.status}): ${url}`);
          if (response.status >= 500 || response.status === 429) {
             // Server error or rate limit, try next ID
             continue;
          }
        }
      } catch (e) {
        console.error(`[SoundCloud] Error fetching with client_id ${clientId.substring(0, 5)}...:`, e);
      }
    }
    return null;
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(cors());
  app.use(express.json());
  app.use(cookieParser());

  // Spotify Auth Routes
  const getSpotifyRedirectUri = (req: express.Request) => {
    const baseUrl = (process.env.APP_URL || (req.headers.origin as string) || `https://${req.headers.host}`).replace(/\/$/, '');
    return `${baseUrl}/api/auth/spotify/callback`;
  };

  app.get('/api/auth/spotify/url', (req, res) => {
    if (!SPOTIFY_CLIENT_ID) {
      return res.status(500).json({ error: 'Spotify Client ID not configured' });
    }
    const redirectUri = getSpotifyRedirectUri(req);
    const scope = 'user-read-private user-read-email user-library-read';
    const params = new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scope,
      show_dialog: 'true'
    });
    res.json({ url: `https://accounts.spotify.com/authorize?${params.toString()}` });
  });

  app.get(['/api/auth/spotify/callback', '/api/auth/spotify/callback/'], async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Code missing');

    const redirectUri = getSpotifyRedirectUri(req);
    try {
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code as string,
          redirect_uri: redirectUri
        })
      });

      const data = await response.json();
      if (data.access_token) {
        res.cookie('spotify_access_token', data.access_token, {
          httpOnly: true,
          secure: true,
          sameSite: 'none',
          maxAge: data.expires_in * 1000
        });
        res.send(`
          <html>
            <body>
              <script>
                if (window.opener) {
                  window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', source: 'spotify' }, '*');
                  window.close();
                } else {
                  window.location.href = '/';
                }
              </script>
              <p>Authentication successful. This window should close automatically.</p>
            </body>
          </html>
        `);
      } else {
        res.status(500).send('Failed to get access token');
      }
    } catch (error) {
      console.error('Spotify Callback Error:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  app.get('/api/spotify/status', (req, res) => {
    const accessToken = req.cookies.spotify_access_token;
    res.json({ authenticated: !!accessToken });
  });

  app.get('/api/spotify/search', async (req, res) => {
    const { q, limit = 50 } = req.query;
    const accessToken = req.cookies.spotify_access_token;

    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      return res.status(500).json({ error: 'Spotify API credentials (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET) are not configured in the Secrets panel.' });
    }

    if (!accessToken) {
      return res.status(401).json({ error: 'Spotify not authenticated' });
    }

    try {
      console.log(`[Spotify] Searching for: ${q}`);
      const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q as string)}&type=track&limit=${limit}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Spotify] Search API failed with status ${response.status}:`, errText);
        
        if (response.status === 401) {
          res.clearCookie('spotify_access_token');
          return res.status(401).json({ error: 'Spotify session expired' });
        }
        
        try {
          const errData = JSON.parse(errText);
          return res.status(response.status).json(errData);
        } catch (e) {
          return res.status(response.status).json({ error: 'Spotify search failed', details: errText });
        }
      }

      const data = await response.json();
      console.log(`[Spotify] Search for "${q}" returned ${data.tracks?.items?.length || 0} results.`);
      res.json(data);
    } catch (error) {
      console.error('Spotify Search Error:', error);
      res.status(500).json({ error: 'Internal Server Error', message: error instanceof Error ? error.message : String(error) });
    }
  });

  // Genius Lyrics Proxy Route
  app.get('/api/lyrics', async (req, res) => {
    const { title, artist } = req.query;
    if (!title || !artist) return res.status(400).json({ error: 'Title and artist required' });

    try {
      let accessToken = GENIUS_ACCESS_TOKEN;

      // Fallback: If no static token, try to exchange ID/Secret for one
      if (!accessToken && GENIUS_CLIENT_ID && GENIUS_CLIENT_SECRET) {
        console.log('[Genius] Attempting to exchange Client ID/Secret for access token...');
        try {
          const authRes = await fetch('https://api.genius.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: GENIUS_CLIENT_ID,
              client_secret: GENIUS_CLIENT_SECRET,
              grant_type: 'client_credentials'
            })
          });
          if (authRes.ok) {
            const authData = await authRes.json();
            accessToken = authData.access_token;
          }
        } catch (e) {
          console.error('[Genius] Token exchange failed:', e);
        }
      }

      if (!accessToken) {
        throw new Error('Genius API key not configured. Please add GENIUS_ACCESS_TOKEN to your Secrets.');
      }

      // 1. Search for the song on Genius
      const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(`${title} ${artist}`)}`;
      const searchRes = await fetch(searchUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!searchRes.ok) throw new Error('Genius Search API failed');
      const searchData = await searchRes.json();
      const hit = searchData.response.hits[0];

      if (!hit) return res.status(404).json({ error: 'Lyrics not found on Genius' });

      const songUrl = hit.result.url;

      // 2. Scrape the lyrics from the Genius page
      console.log(`Fetching Genius lyrics from: ${songUrl}`);
      const pageRes = await fetch(songUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Ch-Ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Upgrade-Insecure-Requests': '1',
          'Referer': 'https://www.google.com/'
        }
      });
      
      if (pageRes.status === 403) {
        throw new Error('Genius scraper blocked (403). Falling back to other sources.');
      }
      
      if (!pageRes.ok) throw new Error(`Failed to fetch Genius page: ${pageRes.status}`);
      const html = await pageRes.text();
      
      const { load } = await import('cheerio');
      const $ = load(html);

      let lyrics = '';
      
      // Try multiple selectors as Genius structure varies
      const selectors = [
        'div[data-lyrics-container="true"]',
        '.lyrics',
        'div[class^="Lyrics__Container"]',
        '#lyrics-root',
        '.song_body-lyrics'
      ];

      for (const selector of selectors) {
        $(selector).each((_, el) => {
          // Replace <br> with newlines
          $(el).find('br').replaceWith('\n');
          // Replace <div> and <p> with newlines to preserve structure
          $(el).find('div, p').each((_, subEl) => {
            $(subEl).append('\n');
          });
          lyrics += $(el).text() + '\n';
        });
        if (lyrics.trim()) break;
      }

      // Final cleanup
      lyrics = lyrics.trim()
        .replace(/\n{3,}/g, '\n\n') // Remove excessive newlines
        .replace(/\[.*?\]/g, ''); // Optional: remove [Verse], [Chorus] etc. if you want clean text

      if (!lyrics) throw new Error('Could not extract lyrics from Genius page content');

      res.json({ lyrics });
    } catch (error: any) {
      console.warn('Genius Lyrics Error, falling back to other sources:', error.message);
      
      try {
        // Fallback 1: lyrics.ovh
        const ovhUrl = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist as string)}/${encodeURIComponent(title as string)}`;
        const ovhRes = await fetch(ovhUrl);
        if (ovhRes.ok) {
          const ovhData = await ovhRes.json();
          if (ovhData.lyrics) {
            console.log('[Lyrics] Found on lyrics.ovh');
            return res.json({ lyrics: ovhData.lyrics });
          }
        }
      } catch (ovhError) {
        console.warn('lyrics.ovh failed:', ovhError);
      }

      try {
        // Fallback 2: Gemini
        const key = getGeminiKey();

        if (!key) {
          throw new Error('GEMINI_API_KEY is not configured. Please add it to enable lyrics fallback.');
        }

        console.log('[Lyrics] Attempting Gemini fallback...');
        const geminiAi = new GoogleGenAI({ apiKey: key });
        const response = await geminiAi.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: `Find and provide the full lyrics for the song "${title}" by "${artist}". 
          If you cannot find the exact lyrics, provide a polite message saying lyrics are unavailable.
          Format the output as plain text with line breaks. Do not include any other text, just the lyrics.`,
          config: {
            tools: [{ googleSearch: {} }] // Use search grounding for better accuracy
          }
        });

        const lyrics = response.text?.trim();
        if (lyrics && !lyrics.toLowerCase().includes('unavailable') && lyrics.length > 50) {
          console.log('[Lyrics] Found via Gemini');
          return res.json({ lyrics });
        }
        
        res.status(404).json({ error: 'Lyrics not found' });
      } catch (geminiError: any) {
        console.error('Gemini Lyrics Fallback Error:', geminiError);
        const message = (geminiError?.message || 'Unknown error').toLowerCase();
        res.status(500).json({ 
          error: `Lyrics service unavailable. ${message.includes('api key') || message.includes('api_key') ? 'Please check your Gemini API key configuration.' : 'Please try again later.'}` 
        });
      }
    }
  });

  // SoundCloud Proxy Routes
  app.get('/api/soundcloud/search', async (req, res) => {
    const { q, limit = 50 } = req.query;
    try {
      console.log(`[SoundCloud] Searching for: ${q}`);
      // Try /search/tracks first (standard for API v2)
      let response = await SoundCloudAPI.fetch('/search/tracks', { q, limit });
      
      // Fallback to /search if /search/tracks fails
      if (!response) {
        console.log(`[SoundCloud] /search/tracks failed, falling back to /search for: ${q}`);
        response = await SoundCloudAPI.fetch('/search', { q, limit });
      }

      // Final fallback: try a different base if needed, or just report failure
      if (!response) {
        console.error(`[SoundCloud] All search attempts failed for: ${q}`);
        return res.status(404).json({ error: 'SoundCloud search failed: All client IDs exhausted or endpoint changed' });
      }

      const data = await response.json();
      
      // Ensure we return a collection even if it's empty
      if (!data.collection) {
        console.warn(`[SoundCloud] Search response missing collection for: ${q}`, data);
        return res.json({ collection: [] });
      }

      res.json(data);
    } catch (error) {
      console.error('Proxy Search Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/api/soundcloud/charts', async (req, res) => {
    const { limit = 50 } = req.query;
    try {
      const genres = [
        '', // No genre (all music)
        'soundcloud:genres:all-music',
        'soundcloud:genres:pop',
        'soundcloud:genres:electronic',
        'soundcloud:genres:rock'
      ];

      const kinds = ['top', 'trending'];

      for (const kind of kinds) {
        for (const genre of genres) {
          const params: any = {
            kind,
            limit,
            offset: 0,
            linked_partitioning: 1
          };
          if (genre) params.genre = genre;

          const response = await SoundCloudAPI.fetch('/charts', params);

          if (response) {
            const data = await response.json();
            if (data.collection && data.collection.length > 0) {
              return res.json(data);
            }
          }
        }
      }

      // Fallback: search
      const fallbackQueries = ['popular', 'trending', 'top hits'];
      for (const q of fallbackQueries) {
        const response = await SoundCloudAPI.fetch('/search/tracks', { q, limit });
        if (response) {
          const data = await response.json();
          if (data.collection && data.collection.length > 0) {
            return res.json({ collection: data.collection.map((track: any) => ({ track })) });
          }
        }
      }
      
      res.status(404).json({ error: 'Could not fetch trending tracks' });
    } catch (error) {
      console.error('Proxy Charts Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/api/soundcloud/track/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const response = await SoundCloudAPI.fetch(`/tracks/${id}`);
      if (!response) return res.status(404).json({ error: 'Track not found' });
      const data = await response.json();
      res.json(data);
    } catch (error) {
      console.error('Proxy Track Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/api/soundcloud/stream', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
      const response = await SoundCloudAPI.fetch(url as string);
      if (!response) {
        console.warn(`SoundCloud stream fetch failed for URL: ${url}`);
        return res.status(404).json({ error: 'Stream not found' });
      }
      const data = await response.json();
      res.json(data);
    } catch (error) {
      console.error('Proxy Stream Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // YouTube Proxy Routes
  app.get('/api/youtube/search', async (req, res) => {
    const { q, limit = 50 } = req.query;
    if (!YOUTUBE_API_KEY) {
      return res.status(500).json({ error: 'YouTube API key not configured' });
    }
    try {
      // 1. Search for videos
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q as string)}&type=video&videoEmbeddable=true&maxResults=${limit}&key=${YOUTUBE_API_KEY}&videoCategoryId=10`;
      const searchRes = await fetch(searchUrl);
      if (!searchRes.ok) {
        const text = await searchRes.text();
        return res.status(searchRes.status).json({ error: 'YouTube Search API error', details: text });
      }
      const searchData = await searchRes.json();
      const videoIds = searchData.items.map((item: any) => item.id.videoId).join(',');

      if (!videoIds) {
        return res.json(searchData);
      }

      // 2. Get video details (for duration)
      const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
      const detailsRes = await fetch(detailsUrl);
      if (!detailsRes.ok) {
        // If details fail, just return search results without durations
        return res.json(searchData);
      }
      const detailsData = await detailsRes.json();
      
      // Merge durations into search results
      const itemsWithDuration = searchData.items.map((item: any) => {
        const details = detailsData.items.find((d: any) => d.id === item.id.videoId);
        return {
          ...item,
          duration: details ? details.contentDetails.duration : null
        };
      });

      res.json({ ...searchData, items: itemsWithDuration });
    } catch (error) {
      console.error('Proxy YouTube Search Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
