-- Run headlessly with Aseprite to remove the flat green background from the
-- generated four-direction jingling sprite sheet.
local input = app.params["input"]
local output = app.params["output"]

if input == nil or output == nil then
    error("Expected --script-param input=<png>,output=<png>")
end

local sprite = Sprite { fromFile = input }
if sprite == nil then
    error("Could not open input sprite: " .. input)
end

for _, cel in ipairs(sprite.cels) do
    local image = cel.image
    for pixel in image:pixels() do
        local color = pixel()
        local red = app.pixelColor.rgbaR(color)
        local green = app.pixelColor.rgbaG(color)
        local blue = app.pixelColor.rgbaB(color)
        local alpha = app.pixelColor.rgbaA(color)
        -- The source uses #00ff00. Keep slightly anti-aliased edge pixels and
        -- fade only pixels that are clearly part of the chroma background.
        if green > 160 and green > red * 1.55 and green > blue * 1.55 then
            local replacement_alpha = math.max(0, math.min(255, (255 - green) * 2))
            pixel(app.pixelColor.rgba(red, green, blue, math.min(alpha, replacement_alpha)))
        end
    end
end

sprite:saveAs(output)
