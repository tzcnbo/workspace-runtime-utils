# Replit OpenRouter 鍙屽吋瀹瑰弽浠?API


## 涓€閿惎鍔?
绌?Replit workspace 閲岀洿鎺ョ矘璐达細

```bash
curl -fsSL https://raw.githubusercontent.com/tzcnbo/replit-openrouter-proxy/main/bootstrap-replit.sh | bash
```

宸茬粡鍦ㄤ粨搴撶洰褰曢噷鍒欐墽琛岋細

```bash
bash ./start-replit.sh
```
鍏紑浠撳簱锛歨ttps://github.com/tzcnbo/replit-openrouter-proxy

鎻愪緵锛?
- OpenAI-compatible锛歚GET /v1/models`銆乣POST /v1/chat/completions`
- Anthropic Messages-compatible锛歚POST /v1/messages`
- 涓婃父缁熶竴鍙皟鐢?Replit OpenRouter 鐨?OpenAI Chat Completions锛歚/chat/completions`
- 澶栭儴鍥哄畾 API Key锛歚tzcnb`

## 鎺ㄨ崘瀹夎鏂瑰紡锛氱洿鎺ヨ鐩栧綋鍓?Replit workspace

鍦?Replit Shell 閲屾墽琛岋細

```bash
cd /home/runner/workspace
[ -d .git ] || git init
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/tzcnbo/replit-openrouter-proxy.git
git fetch origin
git reset --hard origin/main
pnpm install --no-frozen-lockfile
PORT=24927 BASE_PATH=/ pnpm --filter @workspace/api-portal run build
pnpm --filter @workspace/api-server run build
pnpm start
```

涓嶈鐢?`git clone` 鍒板瓙鐩綍锛涘惁鍒?Replit 鐨?Run/Publish 涓嶄細鎶婇」鐩牴鐩綍璇嗗埆瀵广€?
## 蹇€熷鍏?
涔熷彲浠ョ洿鎺ユ墦寮€锛?
```text
https://replit.com/github.com/tzcnbo/replit-openrouter-proxy
```

## Replit 闆嗘垚

鍦?Replit Integrations 涓坊鍔?OpenRouter / AI Gateway / Replit AI锛岃 Replit 鑷姩娉ㄥ叆锛?
- `AI_INTEGRATIONS_OPENROUTER_BASE_URL`
- `AI_INTEGRATIONS_OPENROUTER_API_KEY`

绋嬪簭涔熶細鑷姩灏濊瘯鏌ユ壘鍚嶅瓧閲屽寘鍚?`OPENROUTER`銆乣AI_INTEGRATIONS`銆乣REPLIT`銆乣AI_GATEWAY` 鐨勭瓑浠风幆澧冨彉閲忋€?
## 绔彛

- API Server锛氶粯璁?`8080`
- API Portal锛氬紑鍙戦瑙?`24927`

鐢熶骇/`pnpm start` 浼氬惎鍔?API Server锛屽苟浠?`artifacts/api-portal/dist/public` 闈欐€佹墭绠￠棬鎴烽〉闈€?
## 閴存潈

浠ヤ笅浠讳竴鏂瑰紡鍧囧彲锛?
```http
Authorization: Bearer tzcnb
x-api-key: tzcnb
```

鍏朵粬 token 鎴栨棤 token 閮借繑鍥?401銆?
## 甯哥敤鍛戒护

```bash
pnpm install --no-frozen-lockfile
pnpm build
pnpm start
```

鍗曠嫭鏋勫缓锛?
```bash
PORT=24927 BASE_PATH=/ pnpm --filter @workspace/api-portal run build
pnpm --filter @workspace/api-server run build
```

娴嬭瘯锛?
```bash
curl "http://localhost:8080/v1/models" -H "Authorization: Bearer tzcnb"
```




