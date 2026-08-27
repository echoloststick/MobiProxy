import requests
from flask import Flask, request
import os

app = Flask(__name__)
@app.route("/publish", methods=["POST"])

def publish():
 xml = request.data
 url = request.args.get("url")
 API_KEY = request.headers.get("x-api-key")

 resposta = requests.post(
  url,
  headers={
   "x-api-key": API_KEY,
   "Content-Type": "application/xml"
  },
  data=xml
 )
 return resposta.content, resposta.status_code

app.run(host = "0.0.0.0", port=8080)
