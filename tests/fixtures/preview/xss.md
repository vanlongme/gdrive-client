# Markdown fixture

**bold** and *italic* text with a [safe link](https://example.com).

<script>window.__xss = "script-tag"</script>

[evil javascript link](javascript:window.__xss="js-scheme")
[vbscript link](vbscript:msgbox(1))
[data html link](data:text/html,<script>alert(1)</script>)

![safe image](https://example.com/pixel.png)
![proto relative](//evil.example/track.png)
![backslash host](/\\evil.example/track.png)
![evil image](javascript:alert(1))
![data image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)

<img src="x" onerror="window.__xss='img-onerror'">
