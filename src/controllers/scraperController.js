const scraperService = require('../services/scraperService');

class ScraperController {
  constructor() {
    // In-memory cache as fallback if localStorage isn't available
    this.memoryCache = new Map();
    this.CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds
    
    // Bind methods to preserve 'this' context
    this.getNetflixTop10 = this.getNetflixTop10.bind(this);
    this.getNetflixTVShows = this.getNetflixTVShows.bind(this);
    this.getNetflixMovies = this.getNetflixMovies.bind(this);
    this.getHealth = this.getHealth.bind(this);
    this.clearCacheEndpoint = this.clearCacheEndpoint.bind(this);
  }

  // Helper method to get cache (tries localStorage first, falls back to memory)
  getFromCache(key) {
    try {
      // Try localStorage first (browser environment)
      if (typeof localStorage !== 'undefined') {
        const cached = localStorage.getItem(key);
        if (cached) {
          const data = JSON.parse(cached);
          if (Date.now() < data.expiry) {
            return data.value;
          } else {
            localStorage.removeItem(key);
          }
        }
      }
    } catch (error) {
      // localStorage not available, use memory cache
    }

    // Fallback to memory cache
    const cached = this.memoryCache.get(key);
    if (cached && Date.now() < cached.expiry) {
      return cached.value;
    } else if (cached) {
      this.memoryCache.delete(key);
    }

    return null;
  }

  // Helper method to set cache (tries localStorage first, falls back to memory)
  setCache(key, value) {
    const cacheData = {
      value: value,
      expiry: Date.now() + this.CACHE_DURATION
    };

    try {
      // Try localStorage first (browser environment)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(cacheData));
        return;
      }
    } catch (error) {
      // localStorage not available or storage quota exceeded
    }

    // Fallback to memory cache
    this.memoryCache.set(key, cacheData);
  }

  getNetflixTop10 = async (req, res, next) => {
    try {
      const result = await scraperService.scrapeNetflixTop10('both');
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  getNetflixTVShows = async (req, res, next) => {
    const cacheKey = 'netflix_tv_shows';
    
    try {
      // Check cache first
      const cachedResult = this.getFromCache(cacheKey);
      if (cachedResult) {
        console.log('Returning cached TV shows data');
        return res.json({
          ...cachedResult,
          cached: true,
          cacheTimestamp: new Date().toISOString()
        });
      }

      // If not in cache, fetch fresh data
      console.log('Fetching fresh TV shows data');
      const result = await scraperService.scrapeNetflixTop10('tv');
      
      // Cache the result
      this.setCache(cacheKey, result);
      
      res.json({
        ...result,
        cached: false,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      next(error);
    }
  }

  getNetflixMovies = async (req, res, next) => {
    try {
      const result = await scraperService.scrapeNetflixTop10('movies');
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  getHealth = async (req, res) => {
    // Include cache status in health check
    const cacheStatus = {
      tvShowsCached: this.getFromCache('netflix_tv_shows') !== null,
      cacheType: typeof localStorage !== 'undefined' ? 'localStorage' : 'memory',
      memoryCacheSize: this.memoryCache.size
    };

    res.json({
      service: 'Netflix Scraper API',
      status: 'active',
      target: process.env.TARGET_URL,
      timestamp: new Date().toISOString(),
      cache: cacheStatus
    });
  }

  // Optional: Method to clear cache manually
  clearCache(cacheKey = null) {
    if (cacheKey) {
      // Clear specific cache key
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(cacheKey);
        }
      } catch (error) {
        // localStorage not available
      }
      this.memoryCache.delete(cacheKey);
    } else {
      // Clear all cache
      try {
        if (typeof localStorage !== 'undefined') {
          // Clear only our Netflix cache keys
          const keysToRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('netflix_')) {
              keysToRemove.push(key);
            }
          }
          keysToRemove.forEach(key => localStorage.removeItem(key));
        }
      } catch (error) {
        // localStorage not available
      }
      this.memoryCache.clear();
    }
  }

  // Optional: Endpoint to manually clear cache
  clearCacheEndpoint = async (req, res) => {
    const { key } = req.query;
    this.clearCache(key);
    res.json({
      message: key ? `Cache cleared for key: ${key}` : 'All cache cleared',
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = new ScraperController();