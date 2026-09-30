// k6 load test for the autoscaling demo: ramps up concurrent selfie uploads against /api/match.
//   k6 run -e BASE_URL=http://doppelganger.localtest.me:8080 -e IMAGE=data/test_queries/profile_39.jpg infra/loadtest/match.js
import http from "k6/http";
import encoding from "k6/encoding";
import { check } from "k6";

const image = open(__ENV.IMAGE, "b");
const body = JSON.stringify({ image: "data:image/jpeg;base64," + encoding.b64encode(image) });

export const options = {
  stages: [
    { duration: "30s", target: 4 },
    { duration: "2m", target: 8 },   // sustained load: the HPA should add a backend pod
    { duration: "30s", target: 0 },
  ],
  thresholds: { http_req_failed: ["rate<0.02"], http_req_duration: ["p(95)<5000"] },
};

export default function () {
  const res = http.post(`${__ENV.BASE_URL}/api/match`, body, {
    headers: { "Content-Type": "application/json" },
    timeout: "60s",
  });
  check(res, { "status 200": (r) => r.status === 200, "3 matches": (r) => (r.json("matches") || []).length === 3 });
}
