const axios = require('axios');
const cheerio = require('cheerio');

class ScraperService {
  constructor() {
    this.baseURL = process.env.TARGET_URL;
    this.userAgent = process.env.USER_AGENT;
    this.delay = parseInt(process.env.RATE_LIMIT_DELAY) || 1000;
    this.tmdbApiKey = process.env.TMDB_API_KEY;
    this.tmdbBaseUrl = 'https://api.themoviedb.org/3';
    
    if (!this.tmdbApiKey) {
      console.warn('⚠️ TMDB_API_KEY not found in environment variables. TMDB integration will be disabled.');
    }
  }

  async fetchPage() {
    try {
      const response = await axios.get(this.baseURL, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
        },
        timeout: 10000
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch page: ${error.message}`);
    }
  }

  // TheMovieDB integration methods - Simplified for ID only
  async searchTMDB(title, mediaType = 'multi', countryCode = 'PH') {
    if (!this.tmdbApiKey) {
      console.warn('⚠️ TMDB API key not available, skipping TMDB search');
      return null;
    }

    try {
      // Clean title for better search results
      const cleanTitle = this.cleanTitleForSearch(title);
      
      // Try multiple search strategies for better accuracy
      const searchStrategies = [
        // Strategy 1: Exact title search with region
        { query: cleanTitle, region: countryCode },
        // Strategy 2: Exact title search without region (for international content)
        { query: cleanTitle },
        // Strategy 3: Title with country indicators removed
        { query: this.removeCountryIndicators(cleanTitle) },
        // Strategy 4: First few words only (for long titles)
        { query: cleanTitle.split(' ').slice(0, 3).join(' ') }
      ];

      for (let i = 0; i < searchStrategies.length; i++) {
        const strategy = searchStrategies[i];
        console.log(`🔍 Search strategy ${i + 1}: "${strategy.query}"${strategy.region ? ` (${strategy.region})` : ''}`);
        
        try {
          const searchParams = {
            api_key: this.tmdbApiKey,
            query: strategy.query,
            language: 'en-US',
            page: 1,
            include_adult: false
          };
          
          if (strategy.region) {
            searchParams.region = strategy.region;
          }

          const response = await axios.get(`${this.tmdbBaseUrl}/search/${mediaType}`, {
            params: searchParams,
            timeout: 5000
          });

          if (response.data.results && response.data.results.length > 0) {
            // Find the best match using improved logic
            const bestMatch = this.findBestMatch(response.data.results, title, countryCode, mediaType);
            
            if (bestMatch) {
              console.log(`✅ Found TMDB ID: ${bestMatch.id} for "${bestMatch.title || bestMatch.name}" (${bestMatch.release_date || bestMatch.first_air_date})`);
              
              // Return only the ID and basic info for speed
              return {
                tmdb_id: bestMatch.id,
                tmdb_title: bestMatch.title || bestMatch.name,
                tmdb_release_date: bestMatch.release_date || bestMatch.first_air_date,
                tmdb_media_type: bestMatch.media_type || mediaType,
                search_strategy_used: i + 1
              };
            }
          }
        } catch (strategyError) {
          console.error(`❌ Strategy ${i + 1} failed:`, strategyError.message);
        }
        
        // Small delay between strategies
        await this.wait(100);
      }

      console.log(`❌ No TMDB match found for: "${title}"`);
      return null;
    } catch (error) {
      console.error(`❌ TMDB search failed for "${title}":`, error.message);
      return null;
    }
  }

  // Improved logic to find the best match
  findBestMatch(results, originalTitle, countryCode, mediaType) {
    if (!results || results.length === 0) return null;

    // Filter results by media type if specified
    let filteredResults = results;
    if (mediaType !== 'multi') {
      filteredResults = results.filter(r => (r.media_type || mediaType) === mediaType);
      if (filteredResults.length === 0) {
        filteredResults = results; // Fallback to all results
      }
    }

    // Scoring system for better matching
    const scoredResults = filteredResults.map(result => {
      let score = 0;
      const resultTitle = (result.title || result.name || '').toLowerCase();
      const cleanOriginalTitle = originalTitle.toLowerCase().replace(/[^\w\s]/g, '');
      const cleanResultTitle = resultTitle.replace(/[^\w\s]/g, '');

      // Title similarity (most important factor)
      if (cleanResultTitle === cleanOriginalTitle) {
        score += 100; // Exact match
      } else if (cleanResultTitle.includes(cleanOriginalTitle) || cleanOriginalTitle.includes(cleanResultTitle)) {
        score += 80; // Partial match
      } else {
        // Calculate similarity score
        const similarity = this.calculateStringSimilarity(cleanOriginalTitle, cleanResultTitle);
        score += similarity * 60;
      }

      // Release date preference
      const releaseYear = new Date(result.release_date || result.first_air_date || '1900').getFullYear();
      const currentYear = new Date().getFullYear();
      
      // For Philippines, prefer recent releases (likely adaptations)
      if (countryCode === 'PH') {
        if (releaseYear >= currentYear - 2) score += 30; // Very recent
        else if (releaseYear >= currentYear - 5) score += 20; // Recent
        else if (releaseYear >= 2010) score += 10; // Modern
      } else {
        // For other regions, prefer established content
        if (releaseYear >= 2000 && releaseYear <= currentYear - 1) score += 20;
      }

      // Regional content boost
      if (result.origin_country && result.origin_country.includes(countryCode)) {
        score += 25;
      }

      // Popularity and rating as tiebreakers
      score += Math.min((result.popularity || 0) * 0.1, 10);
      score += Math.min((result.vote_average || 0) * 2, 20);

      // Penalize very old content unless it's a classic
      if (releaseYear < 1990 && (result.vote_average || 0) < 7) {
        score -= 20;
      }

      return { ...result, similarity_score: score };
    });

    // Sort by score and return the best match
    scoredResults.sort((a, b) => b.similarity_score - a.similarity_score);
    
    // Log top 3 matches for debugging
    console.log(`🎯 Top matches for "${originalTitle}":`);
    scoredResults.slice(0, 3).forEach((result, index) => {
      console.log(`   ${index + 1}. "${result.title || result.name}" (${result.release_date || result.first_air_date}) - Score: ${result.similarity_score.toFixed(1)}`);
    });

    return scoredResults[0];
  }

  // Calculate string similarity (simple algorithm)
  calculateStringSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  // Levenshtein distance for string similarity
  levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  // Remove country-specific indicators for cleaner search
  removeCountryIndicators(title) {
    return title
      .replace(/\s*(ph|philippines|filipino|pinoy|tagalog|tl)\s*/gi, '')
      .replace(/\s*\(.*?(ph|philippines|filipino|pinoy).*?\)\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  cleanTitleForSearch(title) {
    return title
      .replace(/^\d+\.\s*/, '') // Remove leading numbers and dots
      .replace(/\s*\(.*?\)\s*/g, '') // Remove content in parentheses
      .replace(/\s*\[.*?\]\s*/g, '') // Remove content in brackets
      .replace(/season\s+\d+/gi, '') // Remove "Season X"
      .replace(/series\s+\d+/gi, '') // Remove "Series X"
      .replace(/\s+/g, ' ') // Normalize spaces
      .trim();
  }

  async enrichWithTMDB(items, countryCode = 'PH') {
    if (!this.tmdbApiKey) {
      console.warn('⚠️ TMDB API key not available, returning items without TMDB data');
      return items;
    }

    console.log(`🎬 Enriching items with TMDB IDs for region: ${countryCode}...`);
    const enrichedItems = [];

    for (const item of items) {
      console.log(`🔍 Searching TMDB ID for: ${item.title}`);
      
      // Determine media type for TMDB search
      const mediaType = item.category === 'Movie' ? 'movie' : 'tv';
      
      const tmdbData = await this.searchTMDB(item.title, mediaType, countryCode);
      
      const enrichedItem = {
        ...item,
        ...tmdbData // Spread TMDB data into the item
      };

      // If we couldn't find it with specific type, try multi search
      if (!tmdbData) {
        console.log(`🔄 Retrying with multi search for: ${item.title}`);
        const multiSearchData = await this.searchTMDB(item.title, 'multi', countryCode);
        if (multiSearchData) {
          Object.assign(enrichedItem, multiSearchData);
        }
      }

      enrichedItems.push(enrichedItem);
      
      // Minimal rate limiting for faster results
      await this.wait(200); // 200ms delay between requests
    }

    const foundCount = enrichedItems.filter(item => item.tmdb_id).length;
    console.log(`✅ Found TMDB IDs for ${foundCount}/${enrichedItems.length} items`);
    
    return enrichedItems;
  }

  parseNetflixTop10(html, type = 'tv') {
    const $ = cheerio.load(html);
    let results = [];

    console.log(`🔍 Parsing FlixPatrol HTML for ${type}...`);
    
    // Parse TV Shows only (default behavior)
    if (type === 'tv' || type === 'both') {
      const tvShows = this.parseTableData($, 'TV Shows');
      results = results.concat(tvShows);
    }
    
    // Parse Movies only if explicitly requested
    if (type === 'movies' || type === 'both') {
      const movies = this.parseTableData($, 'Movies');
      results = results.concat(movies);
    }

    console.log(`📊 Total found: ${results.length} items`);
    return results;
  }

  parseTableData($, sectionType) {
    const results = [];
    const category = sectionType === 'TV Shows' ? 'TV Show' : 'Movie';
    
    console.log(`🎯 Looking for ${sectionType} table data...`);
    
    // Method 1: Find the specific section header first
    let $sectionHeader = null;
    
    if (sectionType === 'TV Shows') {
      // Look for the specific TV Shows header
      $sectionHeader = $('h3.table-th:contains("TOP 10 TV Shows")');
      if ($sectionHeader.length === 0) {
        // Fallback patterns for TV Shows
        $sectionHeader = $('h3:contains("TOP 10 TV Shows"), h2:contains("TOP 10 TV Shows"), .table-th:contains("TOP 10 TV Shows")');
      }
    } else {
      // Look for Movies header
      $sectionHeader = $('h3.table-th:contains("TOP 10 Movies")');
      if ($sectionHeader.length === 0) {
        $sectionHeader = $('h3:contains("TOP 10 Movies"), h2:contains("TOP 10 Movies"), .table-th:contains("TOP 10 Movies")');
      }
    }
    
    if ($sectionHeader.length > 0) {
      console.log(`✅ Found ${sectionType} section header`);
      
      // Find the table or container that follows this header
      let $container = $sectionHeader.parent();
      
      // Look for the table/content container in the next siblings
      let $nextSibling = $sectionHeader.next();
      let attempts = 0;
      
      while ($nextSibling.length > 0 && attempts < 10) {
        const titleLinks = $nextSibling.find('td.table-td a[href*="/title/"]');
        
        if (titleLinks.length > 0) {
          console.log(`🔗 Found ${titleLinks.length} title links in ${sectionType} section`);
          
          titleLinks.each((index, element) => {
            const $link = $(element);
            const title = $link.text().trim();
            const $row = $link.closest('tr');
            
            if (!title) return;
            
            // Try to find rank in the same row
            let rank = null;
            
            // Look for rank in table cells
            const $rankCells = $row.find('td');
            $rankCells.each((i, cell) => {
              const cellText = $(cell).text().trim();
              // Look for standalone numbers 1-10
              if (/^\d+$/.test(cellText)) {
                const num = parseInt(cellText);
                if (num >= 1 && num <= 10) {
                  rank = num;
                  return false; // break
                }
              }
            });
            
            // If no rank found, use position-based ranking
            if (!rank) {
              rank = index + 1;
            }
            
            // Extract poster image if available
            let poster = '';
            const $img = $row.find('img');
            if ($img.length > 0) {
              poster = $img.attr('src') || $img.attr('data-src') || '';
            }
            
            // Only add if rank is valid and we don't already have this rank (allow duplicate titles)
            if (rank >= 1 && rank <= 10 && !results.find(r => r.rank === rank)) {
              results.push({
                rank: rank,
                title: title,
                category: category,
                poster: poster,
                country: 'Philippines',
                platform: 'Netflix'
              });
              
              console.log(`✅ Found: ${rank}. ${title} (${category})`);
            }
          });
          
          break; // Found the content, stop looking
        }
        
        $nextSibling = $nextSibling.next();
        attempts++;
      }
      
      // If we didn't find content in siblings, try looking in the whole container
      if (results.length === 0) {
        console.log('🔍 No content in siblings, searching in parent containers...');
        
        let $searchContainer = $sectionHeader.parent();
        for (let level = 0; level < 3; level++) {
          const titleLinks = $searchContainer.find('td.table-td a[href*="/title/"]');
          
          if (titleLinks.length > 0) {
            console.log(`🔗 Found ${titleLinks.length} title links in parent container`);
            
            titleLinks.each((index, element) => {
              const $link = $(element);
              const title = $link.text().trim();
              
              if (!title || results.length >= 10) return;
              
              // Check if this link comes after our section header in the DOM
              const linkPosition = $link.closest('tr').index();
              const headerPosition = $sectionHeader.index();
              
              // Only include links that come after the header
              if (linkPosition > headerPosition || level > 0) {
                const rank = results.length + 1;
                
                results.push({
                  rank: rank,
                  title: title,
                  category: category,
                  poster: '',
                  country: 'Philippines',
                  platform: 'Netflix'
                });
                
                console.log(`✅ Found: ${rank}. ${title} (${category})`);
              }
            });
            
            break;
          }
          
          $searchContainer = $searchContainer.parent();
        }
      }
    } else {
      console.log(`❌ Could not find ${sectionType} section header`);
      // Fallback to the old method if header not found
      const titleLinks = $('td.table-td a[href*="/title/"]');
      console.log(`🔗 Fallback: Found ${titleLinks.length} total title links`);
      
      titleLinks.slice(0, 10).each((index, element) => {
        const $link = $(element);
        const title = $link.text().trim();
        
        if (title) {
          results.push({
            rank: index + 1,
            title: title,
            category: category,
            poster: '',
            country: 'Philippines',
            platform: 'Netflix'
          });
        }
      });
    }
    
    // Method 2: If we don't have enough results, try parsing by sections
    if (results.length < 8) {
      console.log(`⚠️ Only found ${results.length} items via table parsing, trying section-based parsing...`);
      const sectionResults = this.parseSectionBased($, sectionType);
      
      // Merge results, avoiding duplicate ranks (but allowing duplicate titles)
      sectionResults.forEach(item => {
        if (!results.find(r => r.rank === item.rank)) {
          results.push(item);
        }
      });
    }
    
    // Method 3: If still not enough, try aggressive text parsing
    if (results.length < 8) {
      console.log(`⚠️ Still only ${results.length} items, trying aggressive text parsing...`);
      const textResults = this.parseTextBasedAggressive($, sectionType);
      
      textResults.forEach(item => {
        if (!results.find(r => r.rank === item.rank)) {
          results.push(item);
        }
      });
    }
    
    // Sort by rank and ensure we have unique ranks 1-10 (but allow duplicate titles)
    const finalResults = [];
    const seenRanks = new Set();
    
    results.sort((a, b) => a.rank - b.rank);
    
    for (const item of results) {
      if (!seenRanks.has(item.rank) && 
          item.rank >= 1 && 
          item.rank <= 10) {
        finalResults.push(item);
        seenRanks.add(item.rank);
        
        console.log(`📝 Added: ${item.rank}. ${item.title}`);
      }
    }
    
    // Fill in missing ranks if we can identify them
    if (finalResults.length < 10) {
      console.log(`🔄 Attempting to fill missing ranks (currently have ${finalResults.length}/10)...`);
      this.fillMissingRanks($, finalResults, category);
    }
    
    console.log(`✅ ${sectionType} final results: ${finalResults.length} items`);
    finalResults.forEach(item => console.log(`   ${item.rank}. ${item.title}`));
    
    return finalResults;
  }

  parseSectionBased($, sectionType) {
    const results = [];
    const category = sectionType === 'TV Shows' ? 'TV Show' : 'Movie';
    
    console.log(`📑 Section-based parsing for ${sectionType}...`);
    
    // Look for section headers
    const sectionHeaders = $('h1, h2, h3, h4, .title, .heading').filter((i, el) => {
      const text = $(el).text().toLowerCase();
      return text.includes('top 10') && text.includes(sectionType.toLowerCase().replace(' ', ''));
    });
    
    if (sectionHeaders.length > 0) {
      console.log(`📍 Found section header for ${sectionType}`);
      
      const $section = sectionHeaders.first();
      let $content = $section.next();
      
      // Look through the next several siblings for content
      for (let i = 0; i < 10 && $content.length > 0; i++) {
        const titleLinks = $content.find('a[href*="/title/"]');
        
        titleLinks.each((index, link) => {
          const $link = $(link);
          const title = $link.text().trim();
          
          if (title && results.length < 10) {
            results.push({
              rank: results.length + 1,
              title: title,
              category: category,
              poster: '',
              country: 'Philippines',
              platform: 'Netflix'
            });
          }
        });
        
        $content = $content.next();
      }
    }
    
    return results;
  }

  parseTextBasedAggressive($, sectionType) {
    const results = [];
    const category = sectionType === 'TV Shows' ? 'TV Show' : 'Movie';
    
    console.log(`🔤 Aggressive text parsing for ${sectionType}...`);
    
    const fullText = $.text();
    
    // Try to find the section and extract numbered items
    const sectionKeyword = sectionType === 'TV Shows' ? 'TV Shows' : 'Movies';
    const sectionPattern = new RegExp(`TOP\\s*10\\s*${sectionKeyword}([\\s\\S]*?)(?:TOP\\s*10|$)`, 'i');
    const sectionMatch = fullText.match(sectionPattern);
    
    if (sectionMatch) {
      const sectionText = sectionMatch[1];
      
      // Look for numbered patterns
      const numberedItems = sectionText.match(/(\d+)\.?\s*([^\d\n]{2,100}?)(?=\d+\.|\d+\s|$)/g);
      
      if (numberedItems) {
        numberedItems.forEach(item => {
          const match = item.match(/(\d+)\.?\s*(.*)/);
          if (match) {
            const rank = parseInt(match[1]);
            let title = match[2].trim();
            
            // Clean up title
            title = title.replace(/^\W+/, ''); // Remove leading non-word chars
            title = title.replace(/\d+\s*d\s*$/, ''); // Remove "X d" at end
            title = title.replace(/[–\-]+\s*$/, ''); // Remove trailing dashes
            title = title.split(/\s{3,}/)[0]; // Take first part if multiple spaces
            title = title.trim();
            
            if (title && 
                title.length > 1 && 
                title.length < 100 && 
                rank >= 1 && 
                rank <= 10) {
              results.push({
                rank: rank,
                title: title,
                category: category,
                poster: '',
                country: 'Philippines',
                platform: 'Netflix'
              });
            }
          }
        });
      }
    }
    
    return results;
  }

  fillMissingRanks($, currentResults, category) {
    console.log('🔍 Attempting to find missing ranked items...');
    
    // Get all links to titles that we haven't captured yet
    const allTitleLinks = $('a[href*="/title/"]');
    const existingRanks = new Set(currentResults.map(r => r.rank));
    
    allTitleLinks.each((index, element) => {
      const $link = $(element);
      const title = $link.text().trim();
      
      if (!title) return;
      
      // Try to find an available rank (allow duplicate titles)
      for (let rank = 1; rank <= 10; rank++) {
        if (!existingRanks.has(rank)) {
          currentResults.push({
            rank: rank,
            title: title,
            category: category,
            poster: '',
            country: 'Philippines',
            platform: 'Netflix'
          });
          
          existingRanks.add(rank);
          
          console.log(`🔧 Filled rank ${rank}: ${title}`);
          break;
        }
      }
      
      // Stop if we have 10 items
      if (currentResults.length >= 10) return false;
    });
  }

  async scrapeNetflixTop10(type = 'tv', enrichWithTMDB = true, countryCode = 'PH') {
    try {
      console.log(`🕷️ Starting scrape for ${type} in region: ${countryCode}...`);
      const html = await this.fetchPage();
      console.log(`📄 HTML length: ${html.length} characters`);
      
      let data = this.parseNetflixTop10(html, type);
      
      // Enrich with TMDB data if requested and API key is available
      if (enrichWithTMDB && this.tmdbApiKey && data.length > 0) {
        data = await this.enrichWithTMDB(data, countryCode);
      }
      
      console.log(`✅ Scraped ${data.length} items`);
      
      // If no data found, save HTML for debugging
      if (data.length === 0) {
        console.log('⚠️ No data found. Possible causes:');
        console.log('1. Changed HTML structure');
        console.log('2. JavaScript-rendered content');
        console.log('3. Anti-bot protection');
        
        const fs = require('fs');
        fs.writeFileSync('./debug-html.txt', html.substring(0, 5000));
        console.log('💾 Sample HTML saved to debug-html.txt');
      }
      
      return {
        success: true,
        data,
        scrapedAt: new Date().toISOString(),
        count: data.length,
        type: type,
        countryCode: countryCode,
        enrichedWithTMDB: enrichWithTMDB && !!this.tmdbApiKey
      };
    } catch (error) {
      console.error('❌ Scraping failed:', error.message);
      throw error;
    }
  }

  // Rate limiting helper
  async wait(ms = null) {
    const delay = ms || this.delay;
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  // Helper method to get TMDB ID only (fastest method)
  async getTMDBIdOnly(title, mediaType = 'multi', countryCode = 'PH') {
    const result = await this.searchTMDB(title, mediaType, countryCode);
    return result ? result.tmdb_id : null;
  }

  // Batch method to get multiple TMDB IDs quickly
  async batchGetTMDBIds(titles, mediaType = 'multi', countryCode = 'PH') {
    const results = [];
    
    console.log(`🚀 Batch searching TMDB IDs for ${titles.length} titles...`);
    
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i];
      console.log(`🔍 [${i + 1}/${titles.length}] Searching: ${title}`);
      
      const tmdbId = await this.getTMDBIdOnly(title, mediaType, countryCode);
      results.push({
        title: title,
        tmdb_id: tmdbId
      });
      
      // Minimal delay for speed
      if (i < titles.length - 1) {
        await this.wait(150);
      }
    }
    
    const foundCount = results.filter(r => r.tmdb_id).length;
    console.log(`✅ Found ${foundCount}/${titles.length} TMDB IDs`);
    
    return results;
  }
}

module.exports = new ScraperService();