package com.agui.example.tools;

import com.fasterxml.jackson.annotation.JsonProperty;

public class WeatherResponse {
    private CurrentWeather current;

    public CurrentWeather getCurrent() { return current; }
    public void setCurrent(CurrentWeather current) { this.current = current; }

    public static class CurrentWeather {
        private String time;

        @JsonProperty("temperature_2m")
        private double temperature2m;

        @JsonProperty("apparent_temperature")
        private double apparentTemperature;

        @JsonProperty("relative_humidity_2m")
        private double relativeHumidity2m;

        @JsonProperty("wind_speed_10m")
        private double windSpeed10m;

        @JsonProperty("wind_gusts_10m")
        private double windGusts10m;

        @JsonProperty("weather_code")
        private int weatherCode;

        // Getters and setters
        public String getTime() { return time; }
        public void setTime(String time) { this.time = time; }

        public double getTemperature2m() { return temperature2m; }
        public void setTemperature2m(double temperature2m) { this.temperature2m = temperature2m; }

        public double getApparentTemperature() { return apparentTemperature; }
        public void setApparentTemperature(double apparentTemperature) { this.apparentTemperature = apparentTemperature; }

        public double getRelativeHumidity2m() { return relativeHumidity2m; }
        public void setRelativeHumidity2m(double relativeHumidity2m) { this.relativeHumidity2m = relativeHumidity2m; }

        public double getWindSpeed10m() { return windSpeed10m; }
        public void setWindSpeed10m(double windSpeed10m) { this.windSpeed10m = windSpeed10m; }

        public double getWindGusts10m() { return windGusts10m; }
        public void setWindGusts10m(double windGusts10m) { this.windGusts10m = windGusts10m; }

        public int getWeatherCode() { return weatherCode; }
        public void setWeatherCode(int weatherCode) { this.weatherCode = weatherCode; }
    }
}

