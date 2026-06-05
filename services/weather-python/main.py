from __future__ import annotations

import os
from datetime import datetime

from fastapi import FastAPI
from pydantic import BaseModel


class ForecastRequest(BaseModel):
    meetingId: str
    location: str = "Seattle"
    forecastAt: str


class ForecastResponse(BaseModel):
    meetingId: str
    location: str
    forecastAt: str
    condition: str
    temperatureF: int
    precipitationChance: int
    recommendation: str


app = FastAPI(title="Build 2026 weather readiness")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "weather-python"}


@app.get("/readiness")
def readiness() -> dict[str, str]:
    return {"status": "ready", "service": "weather-python"}


@app.post("/forecast", response_model=ForecastResponse)
def forecast(request: ForecastRequest) -> ForecastResponse:
    return build_forecast(request)


def build_forecast(request: ForecastRequest) -> ForecastResponse:
    location = request.location or "Seattle"
    normalized_location = location.lower()
    forecast_time = parse_forecast_time(request.forecastAt)
    morning_adjustment = -3 if forecast_time and forecast_time.hour < 10 else 0

    if "seattle" in normalized_location or "convention" in normalized_location or "build" in normalized_location:
        condition = "Light rain and cool wind"
        temperature = 58 + morning_adjustment
        precipitation = 72
        recommendation = "Bring a light rain jacket and umbrella; choose shoes that can handle wet sidewalks."
    elif "online" in normalized_location or "teams" in normalized_location or "zoom" in normalized_location:
        condition = "Indoor meeting"
        temperature = 70
        precipitation = 0
        recommendation = "No weather gear needed; use the saved buffer to verify camera, audio, and screen sharing."
    else:
        condition = "Cloudy with a chance of showers"
        temperature = 61 + morning_adjustment
        precipitation = 45
        recommendation = f"Check the route to {location} before leaving and keep a compact umbrella nearby."

    return ForecastResponse(
        meetingId=request.meetingId,
        location=location,
        forecastAt=request.forecastAt,
        condition=condition,
        temperatureF=temperature,
        precipitationChance=precipitation,
        recommendation=recommendation,
    )


def parse_forecast_time(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "4325")))
