"""Build dist/clawd.mcpb (the Claude desktop extension for chat) from extension/ and mcp/."""
import json, os, zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = os.path.join(root, 'dist')
os.makedirs(out_dir, exist_ok=True)
out = os.path.join(out_dir, 'clawd.mcpb')
manifest = json.load(open(os.path.join(root, 'extension', 'manifest.json'), encoding='utf8'))

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('manifest.json', json.dumps(manifest, indent=2))
    z.write(os.path.join(root, 'mcp', 'clawd-mcp.js'), 'server/index.js')
    icon = os.path.join(root, 'extension', 'icon.png')
    if os.path.exists(icon):
        z.write(icon, 'icon.png')
print('built', out, os.path.getsize(out), 'bytes')
