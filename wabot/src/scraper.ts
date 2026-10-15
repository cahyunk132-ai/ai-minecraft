/**
 * scraper.ts — Web reader (axios + cheerio).
 * Ekstrak: judul halaman, meta description, teks paragraf (maks 2000 karakter).
 */
import axios from 'axios';
import * as cheerio from 'cheerio';

export interface WebSummary {
  url: string;
  title: string;
  description: string;
  text: string;
}

const MAX_TEXT = 2000;

function normalizeUrl(input: string): string {
  let url = (input || '').trim();
  if (!url) throw new Error('URL kosong. Gunakan: .web <url>');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('protokol tidak didukung');
    const host = parsed.hostname || '';
    // Hostname harus berupa domain valid (ada titik) atau localhost
    if (host !== 'localhost' && !host.includes('.')) throw new Error('hostname tidak valid');
    return parsed.toString();
  } catch {
    throw new Error('URL tidak valid. Gunakan: .web <url>');
  }
}

function collapseWhitespace(value: string): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

/** Scrape halaman web dan rangkum isinya. */
export async function scrapeWebsite(inputUrl: string): Promise<WebSummary> {
  const url = normalizeUrl(inputUrl);

  let html = '';
  try {
    const res = await axios.get<string>(url, {
      timeout: 15000,
      responseType: 'text',
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    html = res.data;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Gagal mengambil halaman: ${detail}`);
  }

  try {
    const $ = cheerio.load(html);

    // Bersihkan elemen yang bukan konten
    $('script, style, noscript, svg, iframe').remove();

    const title = collapseWhitespace($('title').first().text()) || '(tanpa judul)';

    const description = collapseWhitespace(
      $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') ||
        ''
    );

    const paragraphs = $('p')
      .map((_i, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter((t) => t.length > 0);

    let text = paragraphs.join('\n\n');
    if (!text) {
      // Fallback: ambil teks body bila tidak ada <p>
      text = $('body').text().replace(/\s+/g, ' ').trim();
    }
    if (text.length > MAX_TEXT) {
      text = `${text.slice(0, MAX_TEXT)}…`;
    }

    return { url, title, description, text };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Gagal memproses halaman: ${detail}`);
  }
}
