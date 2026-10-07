import { describe, expect, it } from 'vitest';
import { youtubeId } from './ytPublic';

describe('YouTube のリンクから動画の ID', () => {
  it('いろいろな形のリンク', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=YE7VzlLtp-4&t=10')).toBe('YE7VzlLtp-4');
    expect(youtubeId('https://youtu.be/YE7VzlLtp-4?si=abc')).toBe('YE7VzlLtp-4');
    expect(youtubeId('https://m.youtube.com/watch?v=YE7VzlLtp-4')).toBe('YE7VzlLtp-4');
    expect(youtubeId('https://music.youtube.com/watch?v=YE7VzlLtp-4&list=x')).toBe('YE7VzlLtp-4');
    expect(youtubeId('https://www.youtube.com/shorts/YE7VzlLtp-4')).toBe('YE7VzlLtp-4');
    expect(youtubeId('https://soundcloud.com/forss/flickermood')).toBe(null);
  });
});
