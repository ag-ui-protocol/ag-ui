package com.agui.example.tools;

import javax.validation.constraints.NotBlank;

public class WeatherRequest {
    @NotBlank(message = "Location is required")
    private String location;

    public WeatherRequest() {}

    public WeatherRequest(String location) {
        this.location = location;
    }

    public String getLocation() { return location; }
    public void setLocation(String location) { this.location = location; }
}