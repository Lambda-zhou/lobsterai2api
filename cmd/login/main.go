// login.go — LobsterAI OAuth 登录（本地回调服务器模式）。
//
// 两个子命令，由 login.sh 顺序驱动：
//
//	login url   → 本地起 127.0.0.1 回调服务器，打印登录 URL，状态落 /tmp/lb2api-login-state.json
//	login poll  → 读 state，等待回调，收到 code 后 POST /api/auth/exchange 换 token，
//	              写 auths/lobsterai-{uid}.json，stdout 打印 token+account JSON
//
// 认证流程：浏览器打开 {server}/login?source=electron&redirect_uri=http://127.0.0.1:{port}/auth/callback&state={state}
// 回调带 ?code=X&state=Y → exchange code → accessToken + refreshToken。
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	clientUA        = "LobsterAI/0.1.0"
	authsDir        = "./auths"
	callbackPath    = "/auth/callback"
	callbackTimeout = 10 * time.Minute
	loginCallbackHost = "127.0.0.1"
)

// stateFile 用系统临时目录，跨平台（原硬编码 /tmp 在 Windows 不存在，导致登录直接报错）。
var stateFile = filepath.Join(os.TempDir(), "lb2api-login-state.json")

// serverBase reads upstream API base from LB2A_UPSTREAM_BASE env.
func serverBase() string {
	if v := os.Getenv("LB2A_UPSTREAM_BASE"); v != "" {
		return strings.TrimRight(v, "/")
	}
	fatal("LB2A_UPSTREAM_BASE env not set — cannot determine upstream server")
	return ""
}

// loginPortalURL reads the login portal URL from LB2A_LOGIN_PORTAL env.
func loginPortalURL() string {
	if v := os.Getenv("LB2A_LOGIN_PORTAL"); v != "" {
		return v
	}
	fatal("LB2A_LOGIN_PORTAL env not set — cannot determine login portal URL")
	return ""
}

type loginState struct {
	Port         int    `json:"port"`
	State        string `json:"state"`
	Uuid         string `json:"uuid"`
	FirstKeyfrom string `json:"firstKeyfrom"`
}

// apiEnvelope 上游统一信封。
type apiEnvelope struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "login: "+format+"\n", args...)
	os.Exit(1)
}

// randomHex 生成 n 字节随机 hex。
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		fatal("random: %v", err)
	}
	return hex.EncodeToString(b)
}

// newUuid 生成随机 UUID4。
func newUuid() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		fatal("uuid: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// nowMillis 当前 Unix 毫秒时间戳字符串（keyfrom 格式）。
func nowMillis() string {
	return fmt.Sprintf("%d", time.Now().UnixMilli())
}

// jwtExpiry 解码 JWT payload 的 exp（Unix 秒）；失败返回 0。
func jwtExpiry(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Exp <= 0 {
		return 0
	}
	return claims.Exp
}

// doJSON 发请求并解 {code,msg,data} 信封。
func doJSON(method, fullURL string, body []byte) (json.RawMessage, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, fullURL, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", clientUA)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("http_error: upstream %d: %s", resp.StatusCode, truncate(string(raw), 160))
	}
	var env apiEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("parse failed: %w", err)
	}
	if env.Code != 0 {
		return nil, fmt.Errorf("code=%d msg=%s", env.Code, env.Msg)
	}
	return env.Data, nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// runUrl 启动本地回调服务器并打印登录 URL。
func runUrl() {
	// 清理上一次登录残留（否则旧 .result 会让等待循环立刻误判完成）
	os.Remove(stateFile + ".result")
	os.Remove(stateFile)
	state := randomHex(16)
	uuid := newUuid()
	firstKeyfrom := nowMillis()

	// 绑定随机端口
	ln, err := net.Listen("tcp", loginCallbackHost+":0")
	if err != nil {
		fatal("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	var mu sync.Mutex
	mux.HandleFunc(callbackPath, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		q := r.URL.Query()
		code := q.Get("code")
		gotState := q.Get("state")
		if code == "" || gotState != state {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, "登录回调参数无效")
			return
		}
		// 本进程直接完成 exchange，结果写文件供 login poll 读取
		ls := loginState{
			Port:         port,
			State:        state,
			Uuid:         uuid,
			FirstKeyfrom: firstKeyfrom,
		}
		outRaw := exchange(ls, code)
		if outRaw != nil {
			_ = os.WriteFile(stateFile+".result", outRaw, 0o600)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>")
	})

	srv := &http.Server{Handler: mux}
	go func() {
		_ = srv.Serve(ln)
	}()

	// 状态落盘（poll 子命令读取）
	ls := loginState{
		Port:         port,
		State:        state,
		Uuid:         uuid,
		FirstKeyfrom: firstKeyfrom,
	}
	raw, _ := json.Marshal(ls)
	if err := os.WriteFile(stateFile, raw, 0o600); err != nil {
		fatal("write state: %v", err)
	}

	// 打印登录 URL（portal 登录页，非 server /login API）
	// 登录页校验 redirect_uri 必须是 http://127.0.0.1:{port}/auth/callback
	// 登录成功后前端导航到该回调 → code → exchange
	redirectURI := fmt.Sprintf("http://%s:%d%s", loginCallbackHost, port, callbackPath)
	loginURL := fmt.Sprintf("%s/portal#/login?source=electron&redirect_uri=%s&state=%s",
		loginPortalURL(), urlQueryEscape(redirectURI), state)
	fmt.Println(loginURL)

	// 等待回调完成或超时后自动关闭
	deadline := time.Now().Add(callbackTimeout)
	for {
		if _, err := os.Stat(stateFile + ".result"); err == nil {
			time.Sleep(500 * time.Millisecond) // 给 poll 一点读取窗口
			_ = srv.Close()
			return
		}
		if time.Now().After(deadline) {
			_ = srv.Close()
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func urlQueryEscape(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var out []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' || c == '/' || c == ':':
			out = append(out, c)
		default:
			out = append(out, '%', hexDigits[c>>4], hexDigits[c&0x0f])
		}
	}
	return string(out)
}

// exchange 用 authCode 换 token；成功时写 auth 文件并返回 token+account JSON（失败返回 nil）。
func exchange(ls loginState, code string) []byte {
	body := map[string]any{
		"authCode":      code,
		"firstKeyfrom":  ls.FirstKeyfrom,
		"latestKeyfrom": nowMillis(),
		"uuid":          ls.Uuid,
		"version":       "0.1.0",
	}
	raw, _ := json.Marshal(body)
	data, err := doJSON(http.MethodPost, serverBase()+"/api/auth/exchange", raw)
	if err != nil {
		fmt.Fprintf(os.Stderr, "login: exchange: %v\n", err)
		return nil
	}
	var ex struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int64  `json:"expiresIn"`
		User         struct {
			ID       string `json:"id"`
			Yid      string `json:"yid"`
			UserId   string `json:"userId"`
			Nickname string `json:"nickname"`
		} `json:"user"`
		Quota json.RawMessage `json:"quota"`
	}
	if err := json.Unmarshal(data, &ex); err != nil {
		fmt.Fprintf(os.Stderr, "login: exchange parse: %v\n", err)
		return nil
	}
	if ex.AccessToken == "" {
		fmt.Fprintln(os.Stderr, "login: exchange: no accessToken in response")
		return nil
	}
	uid := ex.User.ID
	if uid == "" {
		uid = ex.User.UserId
	}
	if uid == "" {
		uid = ex.User.Yid
	}
	if uid == "" {
		uid = fmt.Sprintf("%x", sha256.Sum256([]byte(ex.AccessToken)))[:16]
	}

	// 写 auth 文件
	if err := os.MkdirAll(authsDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "login: mkdir auths: %v\n", err)
		return nil
	}
	expiresAt := int64(0)
	if ex.ExpiresIn > 0 {
		expiresAt = time.Now().Add(time.Duration(ex.ExpiresIn) * time.Second).Unix()
	} else if exp := jwtExpiry(ex.AccessToken); exp > 0 {
		// 响应缺 expiresIn 时从 JWT 解 exp（实测 HS512 access token 30 天）
		expiresAt = exp
	}
	doc := map[string]any{
		"auth": map[string]any{
			"accessToken":   ex.AccessToken,
			"refreshToken":  ex.RefreshToken,
			"expiresAt":     expiresAt,
			"uuid":          ls.Uuid,
			"firstKeyfrom":  ls.FirstKeyfrom,
			"latestKeyfrom": nowMillis(),
		},
		"account": map[string]any{
			"uid":      uid,
			"userId":   ex.User.UserId,
			"nickname": ex.User.Nickname,
		},
	}
	outRaw, _ := json.MarshalIndent(doc, "", "  ")
	fp := filepath.Join(authsDir, fmt.Sprintf("lobsterai-%s.json", uid))
	if err := os.WriteFile(fp, outRaw, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "login: write auth: %v\n", err)
		return nil
	}
	fmt.Fprintln(os.Stderr, "login: auth saved:", fp)

	// 返回 token+account JSON（供 poll/脚本消费）
	out := map[string]any{
		"access_token":  ex.AccessToken,
		"refresh_token": ex.RefreshToken,
		"expires_in":    ex.ExpiresIn,
		"uid":           uid,
		"nickname":      ex.User.Nickname,
		"auth_file":     fp,
	}
	oraw, _ := json.Marshal(out)
	return oraw
}

// runPoll 等待 login url 完成（读取 .result 文件）。
func runPoll() {
	deadline := time.Now().Add(callbackTimeout)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(stateFile + ".result"); err == nil {
			fmt.Println(string(raw))
			os.Remove(stateFile + ".result")
			os.Remove(stateFile)
			return
		}
		time.Sleep(time.Second)
	}
	fatal("登录超时（5 分钟内未完成）")
}

func main() {
	if len(os.Args) < 2 {
		fatal("usage: login <url|poll>")
	}
	switch os.Args[1] {
	case "url":
		runUrl()
	case "poll":
		runPoll()
	default:
		fatal("unknown subcommand %q (want url|poll)", os.Args[1])
	}
}
