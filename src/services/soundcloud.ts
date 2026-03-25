/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Track } from '../types';

export interface SoundCloudTrack {
  id: number;
  title: string;
  user: {
    username: string;
    avatar_url: string;
  };
  artwork_url: string;
  duration: number;
  permalink_url: string;
  created_at: string;
  media: {
    transcodings: Array<{
      url: string;
      preset: string;
      snipped: boolean;
      format: {
        protocol: string;
        mime_type: string;
      };
    }>;
  };
}

export const soundCloudToTrack = (scTrack: SoundCloudTrack): Track => ({
  id: scTrack.id.toString(),
  title: scTrack.title,
  artist: scTrack.user.username,
  coverUrl: (scTrack.artwork_url || scTrack.user.avatar_url || '').replace('-large', '-t500x500'),
  duration: formatDuration(scTrack.duration),
  category: 'SoundCloud',
  source: 'soundcloud',
});

const formatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;
};

export const searchTracks = async (query: string): Promise<Track[]> => {
  try {
    const response = await fetch(
      `/api/soundcloud/search?q=${encodeURIComponent(query)}&limit=50`
    );
    if (!response.ok) throw new Error(`SoundCloud search failed: ${response.status}`);
    const data = await response.json();
    if (!data || !data.collection) return [];
    return (data.collection as SoundCloudTrack[]).map(soundCloudToTrack);
  } catch (error) {
    console.error('SoundCloud Search Error:', error);
    return [];
  }
};

export const getTrendingTracks = async (): Promise<Track[]> => {
  try {
    const response = await fetch(`/api/soundcloud/charts?limit=10`);
    if (!response.ok) throw new Error(`SoundCloud charts failed: ${response.status}`);
    const data = await response.json();
    if (!data || !data.collection) {
      console.warn('SoundCloud Charts: No collection found', data);
      return [];
    }
    return (data.collection as { track: SoundCloudTrack }[])
      .filter(item => item && item.track)
      .map(item => soundCloudToTrack(item.track));
  } catch (error) {
    console.error('SoundCloud Charts Error:', error);
    return [];
  }
};

export const getStreamUrl = async (trackId: string): Promise<string | null> => {
  try {
    const response = await fetch(`/api/soundcloud/track/${trackId}`);
    if (!response.ok) return null;
    const track = await response.json() as SoundCloudTrack;
    
    if (!track || !track.media || !track.media.transcodings) {
      console.warn('SoundCloud Stream: Track media or transcodings missing', track);
      return null;
    }
    
    // Find a progressive mp3 transcoding if available
    const progressive = track.media.transcodings.find(t => t.format.protocol === 'progressive');
    const hls = track.media.transcodings.find(t => t.format.protocol === 'hls');
    const transcoding = progressive || hls;

    if (transcoding) {
      const streamRes = await fetch(`/api/soundcloud/stream?url=${encodeURIComponent(transcoding.url)}`);
      if (!streamRes.ok) return null;
      const streamData = await streamRes.json();
      return streamData.url || null;
    }
    return null;
  } catch (error) {
    console.error('SoundCloud Stream Error:', error);
    return null;
  }
};
