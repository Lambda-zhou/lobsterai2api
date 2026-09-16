// config.go 加载 JSON 配置 + 环境变量覆盖。
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config 顶层配置。
type Config struct {
	Listen    string `json:"listen"`     // ":8367"
	APIKey    string `json:"api_key"`    // 空 = 不鉴权
	AuthDir   string `json:"auth_dir"`   // ./auths
	StateFile string `json:"state_file"` // ./data/state.json

	Cooldown struct {
		HardCredit  string `json:"hard_credit"`   // "12h"
		SoftRate    string `json:"soft_rate"`     // "60s"
		ErrThresh   int    `json:"err_threshold"` // 默认 3
		ErrCooldown string `json:"err_cooldown"`  // "10m"
	} `json:"cooldown"`

	Schedule struct {
		CheckinHours   []int `json:"checkin_hours"`   // [9,21]
		KeepaliveHours []int `json:"keepalive_hours"` // [22]
	} `json:"schedule"`

	Upstream struct {
		TimeoutSeconds int    `json:"timeout_seconds"` // 默认 180
		BaseURL        string `json:"base_url"`        // 上游 API base URL（可选）；为空时取 LB2A_UPSTREAM_BASE 环境变量
	} `json:"upstream"`

	// 解析后
	HardCreditDur  time.Duration `json:"-"`
	SoftRateDur    time.Duration `json:"-"`
	ErrCooldownDur time.Duration `json:"-"`
}

// Default 默认配置。
func Default() *Config {
	c := &Config{
		Listen:    ":8367",
		APIKey:    "",
		AuthDir:   "./auths",
		StateFile: "./data/state.json",
	}
	c.Cooldown.HardCredit = "12h"
	c.Cooldown.SoftRate = "60s"
	c.Cooldown.ErrThresh = 3
	c.Cooldown.ErrCooldown = "10m"
	c.Schedule.CheckinHours = []int{9, 21}
	c.Schedule.KeepaliveHours = []int{22}
	c.Upstream.TimeoutSeconds = 180
	return c
}

// Load 从文件读，再用 LB2A_* env 覆盖。
func Load(path string) (*Config, error) {
	c := Default()
	if path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read config: %w", err)
		}
		if err := json.Unmarshal(raw, c); err != nil {
			return nil, fmt.Errorf("parse config: %w", err)
		}
	}
	applyEnv(c)
	if err := c.normalize(); err != nil {
		return nil, err
	}
	return c, nil
}

func applyEnv(c *Config) {
	if v := os.Getenv("LB2A_LISTEN"); v != "" {
		c.Listen = v
	}
	if v := os.Getenv("LB2A_API_KEY"); v != "" {
		c.APIKey = v
	}
	if v := os.Getenv("LB2A_AUTH_DIR"); v != "" {
		c.AuthDir = v
	}
	if v := os.Getenv("LB2A_STATE_FILE"); v != "" {
		c.StateFile = v
	}
	if v := os.Getenv("LB2A_HARD_CREDIT"); v != "" {
		c.Cooldown.HardCredit = v
	}
	if v := os.Getenv("LB2A_SOFT_RATE"); v != "" {
		c.Cooldown.SoftRate = v
	}
	if v := os.Getenv("LB2A_ERR_THRESHOLD"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.Cooldown.ErrThresh = n
		}
	}
	if v := os.Getenv("LB2A_ERR_COOLDOWN"); v != "" {
		c.Cooldown.ErrCooldown = v
	}
	if v := os.Getenv("LB2A_TIMEOUT_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.Upstream.TimeoutSeconds = n
		}
	}
}

func (c *Config) normalize() error {
	var err error
	if c.HardCreditDur, err = time.ParseDuration(c.Cooldown.HardCredit); err != nil {
		return fmt.Errorf("cooldown.hard_credit: %w", err)
	}
	if c.SoftRateDur, err = time.ParseDuration(c.Cooldown.SoftRate); err != nil {
		return fmt.Errorf("cooldown.soft_rate: %w", err)
	}
	if c.ErrCooldownDur, err = time.ParseDuration(c.Cooldown.ErrCooldown); err != nil {
		return fmt.Errorf("cooldown.err_cooldown: %w", err)
	}
	if c.Cooldown.ErrThresh <= 0 {
		c.Cooldown.ErrThresh = 3
	}
	if c.Upstream.TimeoutSeconds <= 0 {
		c.Upstream.TimeoutSeconds = 180
	}
	if !strings.HasPrefix(c.Listen, ":") && !strings.Contains(c.Listen, ":") {
		c.Listen = ":" + c.Listen
	}
	return nil
}
