FROM python:3.11-slim

WORKDIR /app

# Install Claude CLI
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://claude.ai/install.sh | sh && \
    apt-get clean

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "slack_listener.py"]
