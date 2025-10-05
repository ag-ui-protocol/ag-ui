package com.agui.example.tools;

public class WeatherToolResult {
    private double temperature;
    private double feelsLike;
    private double humidity;
    private double windSpeed;
    private double windGust;
    private String conditions;
    private String location;

    // Constructors
    public WeatherToolResult() {}

    public WeatherToolResult(double temperature, double feelsLike, double humidity,
                             double windSpeed, double windGust, String conditions, String location) {
        this.temperature = temperature;
        this.feelsLike = feelsLike;
        this.humidity = humidity;
        this.windSpeed = windSpeed;
        this.windGust = windGust;
        this.conditions = conditions;
        this.location = location;
    }

    // Getters and setters
    public double getTemperature() { return temperature; }
    public void setTemperature(double temperature) { this.temperature = temperature; }

    public double getFeelsLike() { return feelsLike; }
    public void setFeelsLike(double feelsLike) { this.feelsLike = feelsLike; }

    public double getHumidity() { return humidity; }
    public void setHumidity(double humidity) { this.humidity = humidity; }

    public double getWindSpeed() { return windSpeed; }
    public void setWindSpeed(double windSpeed) { this.windSpeed = windSpeed; }

    public double getWindGust() { return windGust; }
    public void setWindGust(double windGust) { this.windGust = windGust; }

    public String getConditions() { return conditions; }
    public void setConditions(String conditions) { this.conditions = conditions; }

    public String getLocation() { return location; }
    public void setLocation(String location) { this.location = location; }
}