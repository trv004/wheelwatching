import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

console.log('Mapbox GL JS Loaded:', mapboxgl);

mapboxgl.accessToken = 'pk.eyJ1IjoidHJ2MDA0IiwiYSI6ImNtYXJreGVidDBiemEycW9lbHVjM2MzOXgifQ.CpD32zXiKB11g-D4X_hkTQ';

// --- Step 5.2 helper function: format minutes to HH:MM AM/PM ---
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/trv004/cmarlwrno01gg01sp2jr5dayj',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

map.on('load', async () => {
  let departuresByMinute = Array.from({ length: 1440 }, () => []);
  let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

  // Add Boston bike lanes
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });

  map.addLayer({
    id: 'bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: {
      'line-color': '#2daf22',
      'line-width': 5,
      'line-opacity': 0.6,
    },
  });

  // Add Cambridge bike lanes
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });

  map.addLayer({
    id: 'cambridge_lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: {
      'line-color': '#2daf22',
      'line-width': 5,
      'line-opacity': 0.6,
    },
  });

  // Declare stations
  let stations = [];

  try {
    const jsonurl = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
    const jsonData = await d3.json(jsonurl);
    stations = jsonData.data.stations;
    console.log('Stations loaded:', stations);
  } catch (error) {
    console.error('Error loading JSON:', error);
  }

  // --- Parse trips CSV with date conversion ---
  let trips = [];
  try {
    const trafficUrl = 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';
    trips = await d3.csv(trafficUrl, (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);
      return trip;
    });
    console.log('Trips loaded:', trips.slice(0, 10));
  } catch (error) {
    console.error('Error loading traffic data:', error);
  }

  // Helper: convert Date to minutes since midnight
  function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  // Function to compute station traffic given stations and filtered trips
  function computeStationTraffic(stations, trips) {
    // Compute departures (start_station_id)
    const departures = d3.rollup(
      trips,
      v => v.length,
      d => d.start_station_id
    );

    // Compute arrivals (end_station_id)
    const arrivals = d3.rollup(
      trips,
      v => v.length,
      d => d.end_station_id
    );

    // Update stations with arrivals, departures, totalTraffic
    return stations.map(station => {
      const id = station.short_name;
      station.departures = departures.get(id) ?? 0;
      station.arrivals = arrivals.get(id) ?? 0;
      station.totalTraffic = station.departures + station.arrivals;
      return station;
    });
  }

  // Initial compute with all trips
  stations = computeStationTraffic(stations, trips);

  // Scale circle size by total traffic
  let radiusScale = d3.scaleSqrt()
    .domain([0, d3.max(stations, d => d.totalTraffic)])
    .range([0, 25]);

  // --- Step 6.1: Define quantize scale for traffic flow color ---
  const stationFlow = d3.scaleQuantize()
    .domain([0, 1])
    .range([0, 0.5, 1]);

  // Create SVG overlay
  const container = map.getCanvasContainer();
  const svg = d3.select(container).append('svg')
    .style('position', 'absolute')
    .style('top', 0)
    .style('left', 0)
    .style('width', '100%')
    .style('height', '100%')
    .style('pointer-events', 'none');

  // Coordinate projection
  function getCoords(station) {
    const point = new mapboxgl.LngLat(+station.lon, +station.lat);
    const { x, y } = map.project(point);
    return { cx: x, cy: y };
  }

  // Create initial circles with key function for efficient updates
  let circles = svg.selectAll('circle')
    .data(stations, d => d.short_name)
    .enter()
    .append('circle')
    .attr('r', d => radiusScale(d.totalTraffic))
    .style('--departure-ratio', d => {
      return d.totalTraffic > 0 ? stationFlow(d.departures / d.totalTraffic) : 0;
    })
    .attr('fill-opacity', 0.6)
    .attr('stroke', 'white')
    .attr('stroke-width', 1)
    .style('pointer-events', 'auto')
    .each(function(d) {
      d3.select(this)
        .append('title')
        .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
    });

  // Update circle positions on map movements
  function updatePositions() {
    circles
      .attr('cx', d => getCoords(d).cx)
      .attr('cy', d => getCoords(d).cy);
  }

  updatePositions();
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // --- Step 5.3: Filtering and updating scatterplot based on time ---

  // Helper to filter trips by time window around timeFilter (minutes)
  function filterTripsbyTime(trips, timeFilter) {
    if (timeFilter === -1) return trips; // no filtering

    return trips.filter(trip => {
      const startedMinutes = minutesSinceMidnight(trip.started_at);
      const endedMinutes = minutesSinceMidnight(trip.ended_at);

      return (
        Math.abs(startedMinutes - timeFilter) <= 60 ||
        Math.abs(endedMinutes - timeFilter) <= 60
      );
    });
  }

  // Initialize timeFilter variable here so updateTimeDisplay can access it
  let timeFilter = -1;

  // Function to update scatterplot circle sizes and colors dynamically based on time filter
  function updateScatterPlot(timeFilter) {
    // Filter trips by time filter
    const filteredTrips = filterTripsbyTime(trips, timeFilter);

    // Recompute traffic data for stations based on filtered trips
    const filteredStations = computeStationTraffic(stations, filteredTrips);

    // Adjust radiusScale range based on filtering to keep circles visible
    if (timeFilter === -1) {
      radiusScale.range([0, 25]);
    } else {
      radiusScale.range([3, 50]);
    }

    // Update data bound to circles with key function
    circles = circles
      .data(filteredStations, d => d.short_name)
      .join(
        enter => enter.append('circle')
          .attr('fill-opacity', 0.6)
          .attr('stroke', 'white')
          .attr('stroke-width', 1)
          .style('pointer-events', 'auto')
          .call(sel => sel.append('title')),
        update => update,
        exit => exit.remove()
      );

    // Update circle attributes
    circles
      .attr('r', d => radiusScale(d.totalTraffic))
      .style('--departure-ratio', d => {
        return d.totalTraffic > 0 ? stationFlow(d.departures / d.totalTraffic) : 0;
      })
      .each(function(d) {
        d3.select(this).select('title').text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`
        );
      });

    // Update circle positions to reflect new data and keep in sync with map
    updatePositions();
  }

  // Select slider and display elements (make sure these IDs exist in your HTML)
  const timeSlider = document.getElementById('timeFilter');
  const selectedTime = document.getElementById('timeDisplay');
  const anyTimeLabel = document.getElementById('anyTimeLabel');

  // Update time display and trigger scatterplot update on slider input
  function updateTimeDisplay() {
    timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';           // Clear time display
      anyTimeLabel.style.display = 'block';   // Show "(any time)"
    } else {
      selectedTime.textContent = formatTime(timeFilter);  // Show formatted time
      anyTimeLabel.style.display = 'none';    // Hide "(any time)"
    }

    updateScatterPlot(timeFilter);
  }

  // Throttle updates using requestAnimationFrame for smooth slider interaction
  function throttleRAF(callback) {
    let ticking = false;
    return function (...args) {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          callback(...args);
          ticking = false;
        });
      }
    };
  }

  const throttledUpdateTimeDisplay = throttleRAF(updateTimeDisplay);
  timeSlider.addEventListener('input', throttledUpdateTimeDisplay);

  // Initialize display on load
  updateTimeDisplay();

});
