/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Track } from '../types';

export interface YouTubeSearchResult {
  id: {
    videoId: string;
  };
  snippet: {
    title: string;
    channelTitle: string;
    thumbnails: {
      default?: { url: string };
      medium?: { url: string };
      high?: { url: string };
    };
  };
  duration?: string; // ISO 8601 duration from details
}

const parseISO8601Duration = (duration: string | null): string => {
  if (!duration) return '0:00';
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '0:00';
  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

export const youtubeToTrack = (ytResult: YouTubeSearchResult): Track => {
  const thumbnails = ytResult.snippet.thumbnails;
  const coverUrl = thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || 'https://picsum.photos/seed/music/400/400';
  
  return {
    id: ytResult.id.videoId,
    title: ytResult.snippet.title,
    artist: ytResult.snippet.channelTitle,
    coverUrl: coverUrl,
    duration: parseISO8601Duration(ytResult.duration || null),
    category: 'YouTube',
    source: 'youtube',
  };
};

export const searchTracks = async (query: string): Promise<Track[]> => {
  try {
    const response = await fetch(
      `/api/youtube/search?q=${encodeURIComponent(query)}&limit=50`
    );
    if (!response.ok) throw new Error(`YouTube search failed: ${response.status}`);
    const data = await response.json();
    if (!data || !data.items) return [];
    return (data.items as YouTubeSearchResult[]).map(youtubeToTrack);
  } catch (error) {
    console.error('YouTube Search Error:', error);
    return [];
  }
};
