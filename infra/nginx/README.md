# Nginx Configuration

## 설정 목적

port 80으로 접속 시 Next.js 앱이 실행 중인 port 3001로 자동 redirect.

## 설치 및 적용 방법

```bash
# nginx 설치
sudo apt-get install -y nginx

# 설정 파일 복사
sudo cp infra/nginx/sites-available/default /etc/nginx/sites-available/default

# 설정 검증 및 재시작
sudo nginx -t && sudo systemctl reload nginx
```

## 서버 정보

- 서버 IP: 172.16.8.250
- redirect: http://172.16.8.250:80 → http://172.16.8.250:3001
