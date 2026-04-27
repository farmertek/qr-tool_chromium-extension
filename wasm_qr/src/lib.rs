use base64::Engine;
use image::{DynamicImage, ImageBuffer, ImageFormat, Luma, Rgba, RgbaImage};
use qrcode::render::svg;
use qrcode::{EcLevel, QrCode};
use rqrr::PreparedImage;
use serde::Serialize;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

mod verify;

const QUIET_ZONE_MODULES: u32 = 2;
const OVERLAY_RATIO_MIN_PERCENT: u32 = 0;
const OVERLAY_RATIO_MAX_PERCENT: u32 = 30;
const OVERLAY_CORNER_RADIUS_MIN_PERCENT: u32 = 0;
const OVERLAY_CORNER_RADIUS_MAX_PERCENT: u32 = 50;
const SYMBOLIC_MODULE_COUNT_MIN: u32 = 21;
const SYMBOLIC_MODULE_COUNT_MAX: u32 = 177;

#[derive(Debug, Clone, Serialize)]
struct OverlayLayout {
    x: u32,
    y: u32,
    side: u32,
    radius: u32,
}

#[wasm_bindgen(start)]
pub fn init_wasm() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn generate_qr_png_data_url(
    content: &str,
    size: u32,
    dark_hex: &str,
    light_hex: &str,
) -> Result<String, JsValue> {
    let content = content.trim();
    if content.is_empty() {
        return Err(js_error("QR content cannot be empty."));
    }

    let dark_color = parse_hex_color(dark_hex)?;
    let light_color = parse_hex_color(light_hex)?;

    let qr_code = QrCode::with_error_correction_level(content.as_bytes(), EcLevel::H)
        .map_err(|error| js_error(&format!("Cannot create QR payload: {error}")))?;

    let requested_size = size.clamp(128, 2048);
    let qr_modules = qr_code.width() as u32;
    let total_modules = qr_modules + QUIET_ZONE_MODULES * 2;
    let module_pixel_size = requested_size.div_ceil(total_modules).max(1);
    let quiet_zone_pixels = QUIET_ZONE_MODULES * module_pixel_size;

    let mask: ImageBuffer<Luma<u8>, Vec<u8>> = qr_code
        .render::<Luma<u8>>()
        .quiet_zone(false)
        .module_dimensions(module_pixel_size, module_pixel_size)
        .build();

    let mut rgba = RgbaImage::from_pixel(
        mask.width() + quiet_zone_pixels * 2,
        mask.height() + quiet_zone_pixels * 2,
        light_color,
    );

    for (x, y, pixel) in mask.enumerate_pixels() {
        let color = if pixel[0] < 128 {
            dark_color
        } else {
            light_color
        };

        rgba.put_pixel(x + quiet_zone_pixels, y + quiet_zone_pixels, color);
    }

    let mut buffer = Cursor::new(Vec::<u8>::new());
    DynamicImage::ImageRgba8(rgba)
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|error| js_error(&format!("Cannot encode PNG: {error}")))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

#[wasm_bindgen]
pub fn generate_qr_svg(content: &str, dark_hex: &str, light_hex: &str) -> Result<String, JsValue> {
    let content = content.trim();
    if content.is_empty() {
        return Err(js_error("QR content cannot be empty."));
    }

    let dark_color = parse_hex_color(dark_hex)?;
    let light_color = parse_hex_color(light_hex)?;

    let dark_hex = to_hex_rgb(dark_color);
    let light_hex = to_hex_rgb(light_color);

    let qr_code = QrCode::with_error_correction_level(content.as_bytes(), EcLevel::H)
        .map_err(|error| js_error(&format!("Cannot create QR payload: {error}")))?;

    Ok(qr_code
        .render::<svg::Color>()
        .quiet_zone(true)
        .dark_color(svg::Color(&dark_hex))
        .light_color(svg::Color(&light_hex))
        .build())
}

#[wasm_bindgen]
pub fn decode_qr_from_rgba(width: u32, height: u32, rgba: Vec<u8>) -> Result<JsValue, JsValue> {
    let expected_len = width as usize * height as usize * 4;
    if rgba.len() != expected_len {
        return Err(js_error(&format!(
            "Invalid RGBA data length: expected {expected_len}, got {}",
            rgba.len()
        )));
    }

    let rgba_image = RgbaImage::from_vec(width, height, rgba)
        .ok_or_else(|| js_error("Cannot reconstruct RGBA image from input bytes."))?;

    let grayscale = DynamicImage::ImageRgba8(rgba_image).to_luma8();
    let mut prepared = PreparedImage::prepare(grayscale);
    let grids = prepared.detect_grids();

    for grid in grids {
        if let Ok((_meta, content)) = grid.decode() {
            return Ok(JsValue::from_str(&content));
        }
    }

    Ok(JsValue::NULL)
}

#[wasm_bindgen]
pub fn compute_overlay_layout(
    canvas_width: u32,
    canvas_height: u32,
    ratio_percent: u32,
    corner_radius_percent: u32,
) -> Result<JsValue, JsValue> {
    let width = canvas_width.max(1);
    let height = canvas_height.max(1);
    let min_side = width.min(height);

    let ratio = ratio_percent.clamp(OVERLAY_RATIO_MIN_PERCENT, OVERLAY_RATIO_MAX_PERCENT);
    let corner_ratio = corner_radius_percent.clamp(
        OVERLAY_CORNER_RADIUS_MIN_PERCENT,
        OVERLAY_CORNER_RADIUS_MAX_PERCENT,
    );

    let side = ((min_side as f64) * (ratio as f64 / 100.0)).round() as u32;
    let radius = ((side as f64) * (corner_ratio as f64 / 100.0)).round() as u32;
    let safe_radius = radius.min(side / 2);

    let layout = OverlayLayout {
        x: (width.saturating_sub(side)) / 2,
        y: (height.saturating_sub(side)) / 2,
        side,
        radius: safe_radius,
    };

    serde_wasm_bindgen::to_value(&layout)
        .map_err(|error| js_error(&format!("Cannot serialize overlay layout: {error}")))
}

#[wasm_bindgen]
pub fn generate_symbolic_qr_mask(module_count: u32) -> Vec<u8> {
    let count = module_count.clamp(SYMBOLIC_MODULE_COUNT_MIN, SYMBOLIC_MODULE_COUNT_MAX);
    let mut mask = Vec::with_capacity((count * count) as usize);

    for row in 0..count {
        for col in 0..count {
            mask.push(if symbolic_module_is_dark(row, col, count) {
                1
            } else {
                0
            });
        }
    }

    mask
}

#[wasm_bindgen]
pub fn compact_history_text(value: &str, max_length: usize) -> String {
    let limit = max_length.clamp(8, 4096);
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");

    if normalized.chars().count() <= limit {
        return normalized;
    }

    let mut compacted = normalized
        .chars()
        .take(limit.saturating_sub(3))
        .collect::<String>();
    compacted.push_str("...");
    compacted
}

#[wasm_bindgen]
pub fn pick_clipboard_image_type(mime_types_multiline: &str) -> String {
    let preferred = [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/bmp",
        "image/svg+xml",
    ];

    let mime_types = mime_types_multiline
        .lines()
        .map(|line| line.trim().to_ascii_lowercase())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();

    for item in preferred {
        if mime_types.iter().any(|mime| mime == item) {
            return item.to_string();
        }
    }

    mime_types
        .into_iter()
        .find(|mime| mime.starts_with("image/"))
        .unwrap_or_default()
}

fn symbolic_module_is_dark(row: u32, col: u32, module_count: u32) -> bool {
    if let Some(finder) = symbolic_finder_module(row, col, module_count) {
        return finder;
    }

    if let Some(alignment) = symbolic_alignment_module(row, col, module_count) {
        return alignment;
    }

    if symbolic_timing_module(row, col, module_count) {
        return (row + col) % 2 == 0;
    }

    let pseudo = row * 73 + col * 151 + row * col * 17 + ((row ^ col) * 29);
    pseudo % 11 < 5
}

fn symbolic_finder_module(row: u32, col: u32, module_count: u32) -> Option<bool> {
    let starts = [
        (0, 0),
        (0, module_count.saturating_sub(7)),
        (module_count.saturating_sub(7), 0),
    ];

    for (start_row, start_col) in starts {
        if row >= start_row && row < start_row + 7 && col >= start_col && col < start_col + 7 {
            let local_row = row - start_row;
            let local_col = col - start_col;

            let outer_ring = local_row == 0 || local_row == 6 || local_col == 0 || local_col == 6;
            let inner_white_ring =
                local_row == 1 || local_row == 5 || local_col == 1 || local_col == 5;

            if outer_ring {
                return Some(true);
            }

            if inner_white_ring {
                return Some(false);
            }

            return Some(true);
        }
    }

    None
}

fn symbolic_alignment_module(row: u32, col: u32, module_count: u32) -> Option<bool> {
    let start = module_count.saturating_sub(11);
    if row < start || row >= start + 5 || col < start || col >= start + 5 {
        return None;
    }

    let local_row = row - start;
    let local_col = col - start;
    let border = local_row == 0 || local_row == 4 || local_col == 0 || local_col == 4;
    let center = local_row == 2 && local_col == 2;
    Some(border || center)
}

fn symbolic_timing_module(row: u32, col: u32, module_count: u32) -> bool {
    if module_count <= 16 {
        return false;
    }

    let timing_range_start = 8;
    let timing_range_end = module_count.saturating_sub(8);

    (row == 6 && col >= timing_range_start && col < timing_range_end)
        || (col == 6 && row >= timing_range_start && row < timing_range_end)
}

fn parse_hex_color(input: &str) -> Result<Rgba<u8>, JsValue> {
    let hex = input.trim().trim_start_matches('#');

    let parse = |range: std::ops::Range<usize>| {
        u8::from_str_radix(&hex[range], 16)
            .map_err(|_| js_error(&format!("Invalid color channel in: {input}")))
    };

    match hex.len() {
        6 => {
            let red = parse(0..2)?;
            let green = parse(2..4)?;
            let blue = parse(4..6)?;
            Ok(Rgba([red, green, blue, 255]))
        }
        8 => {
            let red = parse(0..2)?;
            let green = parse(2..4)?;
            let blue = parse(4..6)?;
            let alpha = parse(6..8)?;
            Ok(Rgba([red, green, blue, alpha]))
        }
        _ => Err(js_error(&format!(
            "Invalid color format: {input}. Expected #RRGGBB or #RRGGBBAA"
        ))),
    }
}

fn to_hex_rgb(color: Rgba<u8>) -> String {
    format!("#{:02X}{:02X}{:02X}", color[0], color[1], color[2])
}

fn js_error(message: &str) -> JsValue {
    JsValue::from_str(message)
}
