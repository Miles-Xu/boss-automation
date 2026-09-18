# 参考项目、平台说明与依赖

## 致谢

开发过程中借鉴了 [reconcrap-cpu/boss-recommend-mcp](https://github.com/reconcrap-cpu/boss-recommend-mcp/tree/85a107609ba2a0f6815909432d1737fa51a3a3de) 的部分思路。感谢作者公开自己的探索和代码，让后来者少走了不少弯路。

核对版本为 `2.0.43`，该版本的 [package.json](https://github.com/reconcrap-cpu/boss-recommend-mcp/blob/85a107609ba2a0f6815909432d1737fa51a3a3de/package.json) 声明 MIT。

## 关于 BOSS 直聘

感谢 BOSS 直聘长期提供和维护招聘服务。本项目是个人开发的非官方项目，与 BOSS 直聘不存在隶属、合作或背书关系。BOSS 直聘的名称和标识归其权利人所有。

请只在获得授权的账号和数据范围内使用，并遵守平台规则和适用法律。本项目不提供验证码、安全验证、访问控制或频率限制的绕过能力。

## 运行依赖

依赖通过 npm 安装，不复制进本仓库。各包随附的许可证保留原署名。



* `chrome-remote-interface@0.33.3`，MIT，Copyright (c) 2025 Andrea Cardaci。

* `commander@2.11.0`，MIT，Copyright (c) 2011 TJ Holowaychuk；由 `chrome-remote-interface` 引入。

* `ws@7.5.13`，MIT，Copyright (c) 2011 Einar Otto Stangvik；由 `chrome-remote-interface` 引入。

具体依赖版本以 `package-lock.json` 为准；许可证位于相应包的 `LICENSE` 文件。