FROM python:3.11-slim

WORKDIR /app

COPY slack-listener/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY slack-listener/ ./

CMD ["python", "slack_listener.py"]
