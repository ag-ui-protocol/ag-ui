package com.agui.example.tools;

import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

public class WeatherTool implements Function<WeatherRequest, WeatherToolResult> {

    private final RestTemplate restTemplate;

    public WeatherTool() {
        this.restTemplate = new RestTemplate();
    }
    private static final Map<Integer, String> WEATHER_CONDITIONS = new HashMap<>();

    static {
        WEATHER_CONDITIONS.put(0, "Clear sky");
        WEATHER_CONDITIONS.put(1, "Mainly clear");
        WEATHER_CONDITIONS.put(2, "Partly cloudy");
        WEATHER_CONDITIONS.put(3, "Overcast");
        WEATHER_CONDITIONS.put(45, "Foggy");
        WEATHER_CONDITIONS.put(48, "Depositing rime fog");
        WEATHER_CONDITIONS.put(51, "Light drizzle");
        WEATHER_CONDITIONS.put(53, "Moderate drizzle");
        WEATHER_CONDITIONS.put(55, "Dense drizzle");
        WEATHER_CONDITIONS.put(56, "Light freezing drizzle");
        WEATHER_CONDITIONS.put(57, "Dense freezing drizzle");
        WEATHER_CONDITIONS.put(61, "Slight rain");
        WEATHER_CONDITIONS.put(63, "Moderate rain");
        WEATHER_CONDITIONS.put(65, "Heavy rain");
        WEATHER_CONDITIONS.put(66, "Light freezing rain");
        WEATHER_CONDITIONS.put(67, "Heavy freezing rain");
        WEATHER_CONDITIONS.put(71, "Slight snow fall");
        WEATHER_CONDITIONS.put(73, "Moderate snow fall");
        WEATHER_CONDITIONS.put(75, "Heavy snow fall");
        WEATHER_CONDITIONS.put(77, "Snow grains");
        WEATHER_CONDITIONS.put(80, "Slight rain showers");
        WEATHER_CONDITIONS.put(81, "Moderate rain showers");
        WEATHER_CONDITIONS.put(82, "Violent rain showers");
        WEATHER_CONDITIONS.put(85, "Slight snow showers");
        WEATHER_CONDITIONS.put(86, "Heavy snow showers");
        WEATHER_CONDITIONS.put(95, "Thunderstorm");
        WEATHER_CONDITIONS.put(96, "Thunderstorm with slight hail");
        WEATHER_CONDITIONS.put(99, "Thunderstorm with heavy hail");
    }

    public WeatherToolResult apply(final WeatherRequest request) {
        // Get geocoding data
        GeocodingResponse.GeocodingResult geocodingResult = getGeocodingData(request.getLocation());

        // Get weather data
        WeatherResponse weatherData = getWeatherData(geocodingResult.getLatitude(), geocodingResult.getLongitude());

        // Build and return result
        return new WeatherToolResult(
            weatherData.getCurrent().getTemperature2m(),
            weatherData.getCurrent().getApparentTemperature(),
            weatherData.getCurrent().getRelativeHumidity2m(),
            weatherData.getCurrent().getWindSpeed10m(),
            weatherData.getCurrent().getWindGusts10m(),
            getWeatherCondition(weatherData.getCurrent().getWeatherCode()),
            geocodingResult.getName()
        );
    }

    private GeocodingResponse.GeocodingResult getGeocodingData(String location) {
        String geocodingUrl = UriComponentsBuilder
                .fromHttpUrl("https://geocoding-api.open-meteo.com/v1/search")
                .queryParam("name", location)
                .queryParam("count", 1)
                .toUriString();

        GeocodingResponse geocodingResponse = restTemplate.getForObject(geocodingUrl, GeocodingResponse.class);

        if (geocodingResponse == null ||
                geocodingResponse.getResults() == null ||
                geocodingResponse.getResults().isEmpty()) {
            throw new RuntimeException("Location '" + location + "' not found");
        }

        return geocodingResponse.getResults().get(0);
    }

    private WeatherResponse getWeatherData(double latitude, double longitude) {
        String weatherUrl = UriComponentsBuilder
                .fromHttpUrl("https://api.open-meteo.com/v1/forecast")
                .queryParam("latitude", latitude)
                .queryParam("longitude", longitude)
                .queryParam("current", "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code")
                .toUriString();

        return restTemplate.getForObject(weatherUrl, WeatherResponse.class);
    }

    private String getWeatherCondition(int code) {
        return WEATHER_CONDITIONS.getOrDefault(code, "Unknown");
    }


}