"""Rebuild the simple application icon. Requires Pillow only during icon editing."""
from pathlib import Path
import sys
from PIL import Image, ImageDraw

dest = Path(__file__).resolve().parent.parent / "desktop" / "assets"
dest.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((28, 28, 996, 996), radius=210, fill="#203E53")
draw.rounded_rectangle((275, 190, 749, 824), radius=48, fill="#F8FAFC")
draw.line((368, 330, 656, 330), fill="#203E53", width=36)
draw.line((368, 420, 594, 420), fill="#93A8B5", width=28)
draw.line((368, 505, 566, 505), fill="#93A8B5", width=28)
draw.ellipse((525, 568, 873, 916), fill="#358465")
draw.line((608, 744, 674, 809, 794, 674), fill="#FFFFFF", width=38, joint="curve")
if "--ios-only" not in sys.argv:
    image.save(dest / "icon.png")
    image.save(dest / "icon.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    image.save(dest / "icon.icns")
# iOS applies its own corner mask and rejects any alpha channel at upload.
# Render the same icon on its solid background without a desktop-style border.
ios_image = Image.new("RGB", image.size, "#203E53")
ios_image.paste(image, mask=image.getchannel("A"))
ios_image.save(dest.parent.parent / "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
