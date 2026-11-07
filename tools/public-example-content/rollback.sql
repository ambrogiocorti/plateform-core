-- Disable only this example catalogue. Check for subsequent changes before running.
update public.dishes set active=false where id in ('cfcd439a-ff00-58d8-859b-fb69bd857d9a','7f7a7c84-18f9-59ff-83e3-8fb94aedac22','35aec3f4-853e-5bc9-bfa2-c581dadfb857','e89393f5-36ab-5e51-99e8-a2840c9f01bd','3fa3887b-c1a1-5f45-805f-2a5bbf5ccb8d','c9c04c8f-a35d-5997-991d-ec3bf1c4841d','2441d7d4-8f32-5cad-be52-d227a91a1d87','27c2d800-aa14-567a-b0f2-2660c00913c3');
-- Restore public_content from the captured configuration only after reviewing edits.
