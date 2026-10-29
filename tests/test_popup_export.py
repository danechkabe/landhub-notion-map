"""Popup fields use exactly Photo and Phone, including inactive parcels."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest

try:
    import requests
except ImportError:
    sys.modules['requests'] = types.ModuleType('requests')

spec = importlib.util.spec_from_file_location('popup_export', Path(__file__).resolve().parents[1]/'scripts/update_map_data.py')
export = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = export
spec.loader.exec_module(export)


class Photos:
    def __init__(self): self.calls = []
    def process(self, url, **kwargs):
        if url:
            self.calls.append((url, kwargs))
            return './assets/generated-photos/test.jpg'
        return ''


class PopupExportTests(unittest.TestCase):
    def page(self):
        return {'id': 'p1', 'properties': {
            'Name': {'title': [{'plain_text': 'Test'}]},
            'Мапа': {'url': 'https://maps.google.com/?q=50.2,30.3'},
            'Photo': {'files': [{'type': 'file', 'file': {'url': 'https://photos.test/main.jpg'}}]},
            'Phone': {'type': 'phone_number', 'phone_number': '+380671234567'},
            'Фотографії': {'files': [{'type': 'external', 'external': {'url': 'https://photos.test/gallery.jpg'}}]},
        }}

    def test_inactive_popup_uses_main_photo_and_phone_without_gallery_download(self):
        photos = Photos()
        item = export.normalize_page('deactivated', self.page(), session=None, photo_processor=photos)
        self.assertEqual(item['popup_photo_url'], './assets/generated-photos/test.jpg')
        self.assertEqual(item['phone'], '+380671234567')
        self.assertEqual([url for url,_ in photos.calls], ['https://photos.test/main.jpg'])

    def test_missing_optional_fields_stay_empty(self):
        page = self.page()
        del page['properties']['Photo']
        del page['properties']['Phone']
        item = export.normalize_page('deactivated', page, session=None, photo_processor=Photos())
        self.assertEqual(item['popup_photo_url'], '')
        self.assertEqual(item['phone'], '')

    def test_phone_rich_text_and_empty_number(self):
        self.assertEqual(export.extract_phone({'type': 'rich_text', 'rich_text': [{'plain_text': '067 123 45 67'}]}), '067 123 45 67')
        self.assertEqual(export.extract_phone({'type': 'phone_number', 'phone_number': None}), '')


if __name__ == '__main__':
    unittest.main()
