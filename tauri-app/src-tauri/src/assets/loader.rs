use image::GenericImageView;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const PNG_ALPHA_THRESHOLD: u8 = 128;
const WALL_PIECE_WIDTH: u32 = 16;
const WALL_PIECE_HEIGHT: u32 = 32;
const WALL_GRID_COLS: u32 = 4;
const WALL_BITMASK_COUNT: u32 = 16;
const FLOOR_PATTERN_COUNT: u32 = 7;
const FLOOR_TILE_SIZE: u32 = 16;
const CHAR_FRAME_W: u32 = 16;
const CHAR_FRAME_H: u32 = 32;
const CHAR_FRAMES_PER_ROW: u32 = 7;
const CHAR_COUNT: u32 = 6;
const CHAR_DIRECTIONS: u32 = 3; // down, up, right

/// 2D array of hex color strings ("" = transparent, "#RRGGBB" = opaque)
pub type SpriteData = Vec<Vec<String>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FurnitureCatalogEntry {
    pub id: String,
    pub name: String,
    pub label: String,
    pub category: String,
    pub file: String,
    pub width: u32,
    pub height: u32,
    pub footprint_w: u32,
    pub footprint_h: u32,
    #[serde(default)]
    pub is_desk: bool,
    #[serde(default)]
    pub can_place_on_walls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_of_group: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_place_on_surfaces: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_tiles: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FurnitureCatalogFile {
    assets: Vec<FurnitureCatalogEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CharacterDirectionSprites {
    pub down: Vec<SpriteData>,
    pub up: Vec<SpriteData>,
    pub right: Vec<SpriteData>,
}

fn pixel_to_hex(r: u8, g: u8, b: u8, a: u8) -> String {
    if a < PNG_ALPHA_THRESHOLD {
        String::new()
    } else {
        format!("#{:02X}{:02X}{:02X}", r, g, b)
    }
}

fn png_to_sprite_data(img: &image::DynamicImage, x: u32, y: u32, w: u32, h: u32) -> SpriteData {
    let mut sprite = Vec::with_capacity(h as usize);
    for row in 0..h {
        let mut line = Vec::with_capacity(w as usize);
        for col in 0..w {
            let px = img.get_pixel(x + col, y + row);
            line.push(pixel_to_hex(px[0], px[1], px[2], px[3]));
        }
        sprite.push(line);
    }
    sprite
}

pub fn load_furniture_assets(
    assets_root: &Path,
) -> Option<(Vec<FurnitureCatalogEntry>, HashMap<String, SpriteData>)> {
    let catalog_path = assets_root.join("assets/furniture/furniture-catalog.json");
    if !catalog_path.exists() {
        println!("[AssetLoader] No furniture catalog at: {}", catalog_path.display());
        return None;
    }

    let content = fs::read_to_string(&catalog_path).ok()?;
    let catalog_file: FurnitureCatalogFile = serde_json::from_str(&content).ok()?;
    let catalog = catalog_file.assets;
    let mut sprites = HashMap::new();

    for asset in &catalog {
        let mut file_path = asset.file.clone();
        if !file_path.starts_with("assets/") {
            file_path = format!("assets/{}", file_path);
        }
        let asset_path = assets_root.join(&file_path);

        if !asset_path.exists() {
            eprintln!("[AssetLoader] Asset file not found: {}", asset.file);
            continue;
        }

        match image::open(&asset_path) {
            Ok(img) => {
                let sprite = png_to_sprite_data(&img, 0, 0, asset.width, asset.height);
                sprites.insert(asset.id.clone(), sprite);
            }
            Err(e) => {
                eprintln!("[AssetLoader] Error loading {}: {}", asset.id, e);
            }
        }
    }

    println!(
        "[AssetLoader] Loaded {}/{} furniture sprites",
        sprites.len(),
        catalog.len()
    );
    Some((catalog, sprites))
}

pub fn load_default_layout(assets_root: &Path) -> Option<serde_json::Value> {
    let layout_path = assets_root.join("assets/default-layout.json");
    if !layout_path.exists() {
        return None;
    }
    let content = fs::read_to_string(&layout_path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn load_wall_tiles(assets_root: &Path) -> Option<Vec<SpriteData>> {
    let wall_path = assets_root.join("assets/walls.png");
    if !wall_path.exists() {
        return None;
    }

    let img = image::open(&wall_path).ok()?;
    let mut sprites = Vec::with_capacity(WALL_BITMASK_COUNT as usize);

    for mask in 0..WALL_BITMASK_COUNT {
        let ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
        let oy = (mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
        sprites.push(png_to_sprite_data(&img, ox, oy, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT));
    }

    println!("[AssetLoader] Loaded {} wall tile pieces", sprites.len());
    Some(sprites)
}

pub fn load_floor_tiles(assets_root: &Path) -> Option<Vec<SpriteData>> {
    let floor_path = assets_root.join("assets/floors.png");
    if !floor_path.exists() {
        return None;
    }

    let img = image::open(&floor_path).ok()?;
    let mut sprites = Vec::with_capacity(FLOOR_PATTERN_COUNT as usize);

    for t in 0..FLOOR_PATTERN_COUNT {
        let ox = t * FLOOR_TILE_SIZE;
        sprites.push(png_to_sprite_data(&img, ox, 0, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE));
    }

    println!("[AssetLoader] Loaded {} floor tile patterns", sprites.len());
    Some(sprites)
}

pub fn load_character_sprites(assets_root: &Path) -> Option<Vec<CharacterDirectionSprites>> {
    let char_dir = assets_root.join("assets/characters");
    let mut characters = Vec::with_capacity(CHAR_COUNT as usize);

    for ci in 0..CHAR_COUNT {
        let file_path = char_dir.join(format!("char_{}.png", ci));
        if !file_path.exists() {
            eprintln!("[AssetLoader] No character sprite at: {}", file_path.display());
            return None;
        }

        let img = image::open(&file_path).ok()?;
        let mut char_data = CharacterDirectionSprites {
            down: Vec::new(),
            up: Vec::new(),
            right: Vec::new(),
        };

        for dir_idx in 0..CHAR_DIRECTIONS {
            let row_offset_y = dir_idx * CHAR_FRAME_H;
            let mut frames = Vec::with_capacity(CHAR_FRAMES_PER_ROW as usize);

            for f in 0..CHAR_FRAMES_PER_ROW {
                let frame_offset_x = f * CHAR_FRAME_W;
                frames.push(png_to_sprite_data(
                    &img,
                    frame_offset_x,
                    row_offset_y,
                    CHAR_FRAME_W,
                    CHAR_FRAME_H,
                ));
            }

            match dir_idx {
                0 => char_data.down = frames,
                1 => char_data.up = frames,
                2 => char_data.right = frames,
                _ => unreachable!(),
            }
        }
        characters.push(char_data);
    }

    println!(
        "[AssetLoader] Loaded {} character sprites ({} frames x 3 dirs each)",
        characters.len(),
        CHAR_FRAMES_PER_ROW
    );
    Some(characters)
}
