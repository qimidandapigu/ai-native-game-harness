using System;
using System.IO;
using UnityEngine;

namespace DoubaoAI.ONI.Assets
{
    internal static class TextureLoader
    {
        internal static Texture2D LoadPng(string path)
        {
            try
            {
                if (!File.Exists(path)) return null;
                var texture = new Texture2D(2, 2, TextureFormat.ARGB32, false);
                if (!texture.LoadImage(File.ReadAllBytes(path)))
                {
                    UnityEngine.Object.Destroy(texture);
                    return null;
                }
                // ONI renders the companion as smooth UI art. Bilinear sampling keeps
                // the high-resolution source clean when it is drawn at 72x72.
                texture.filterMode = FilterMode.Bilinear;
                texture.wrapMode = TextureWrapMode.Clamp;
                return texture;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[DoubaoAI] 读取形象资源失败：" + ex.Message);
                return null;
            }
        }
    }
}
