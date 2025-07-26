const express = require('express');
const scraperController = require('../controllers/scraperController');

const router = express.Router();

// GET /api/scraper/netflix/top10 - Get both TV shows and movies
router.get('/netflix/top10', scraperController.getNetflixTop10);

// GET /api/scraper/netflix/tv - Get only TV shows
router.get('/netflix/tv', scraperController.getNetflixTVShows);

// GET /api/scraper/netflix/movies - Get only movies
router.get('/netflix/movies', scraperController.getNetflixMovies);

// GET /api/scraper/health
router.get('/health', scraperController.getHealth);

module.exports = router;