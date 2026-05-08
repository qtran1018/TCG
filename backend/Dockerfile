# Official Playwright image: Python 3.12 + Ubuntu Noble + Chromium pre-installed
FROM mcr.microsoft.com/playwright/python:v1.47.0-noble

WORKDIR /app

COPY requirements.txt .
# Skip playwright itself from pip since the base image provides it
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

EXPOSE 8000
